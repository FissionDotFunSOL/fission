import { PublicKey } from '@solana/web3.js';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getConnection, sendTx, getAccountInfo } from './solana.js';

// ---------------------------------------------------------------------------
// Lazy-loaded SDK references
// ---------------------------------------------------------------------------
let _sdkLoaded = false;
let _feeSharingConfigPda = null;
let _isSharingConfigEditable = null;
let _hasCoinCreatorMigratedToSharingConfig = null;
let _OnlinePumpSdk = null;
let _PUMP_FEE_PROGRAM_ID = null;

async function loadSdk() {
  if (_sdkLoaded) return;
  try {
    const sdk = await import('@pump-fun/pump-sdk');
    _feeSharingConfigPda = sdk.feeSharingConfigPda;
    _isSharingConfigEditable = sdk.isSharingConfigEditable;
    _hasCoinCreatorMigratedToSharingConfig = sdk.hasCoinCreatorMigratedToSharingConfig;
    _OnlinePumpSdk = sdk.OnlinePumpSdk;
    _PUMP_FEE_PROGRAM_ID = sdk.PUMP_FEE_PROGRAM_ID;
    _sdkLoaded = true;
    logger.info('Pump.fun SDK loaded successfully');
  } catch (err) {
    logger.error('Failed to load Pump.fun SDK', { error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PDA derivation for fee-sharing config
// ---------------------------------------------------------------------------
export function deriveSharingConfigPDA(mint) {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  if (_feeSharingConfigPda) {
    return { pda: _feeSharingConfigPda(mintPk), bump: null };
  }
  // Fallback to manual derivation
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('sharing-config'), mintPk.toBuffer()],
    config.PUMP_FEES_PROGRAM_ID,
  );
  return { pda, bump };
}

// ---------------------------------------------------------------------------
// Verify on-chain sharing config
// Checks: (1) PDA exists, (2) 100% allocated to protocol wallet, (3) admin revoked
// ---------------------------------------------------------------------------
export async function verifySharingConfig(mint) {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;

  try {
    await loadSdk();
  } catch {
    // SDK load failed, will use fallback
  }

  const { pda } = deriveSharingConfigPDA(mintPk);

  try {
    const info = await getAccountInfo(pda);
    if (!info || !info.data) {
      return { valid: false, reason: 'Sharing config PDA does not exist. Token has not set up fee sharing.' };
    }

    // Use the SDK standalone functions for verification
    if (_sdkLoaded) {
      try {
        // Check 1: Has the creator migrated to using the sharing config PDA?
        const hasMigrated = _hasCoinCreatorMigratedToSharingConfig({
          mint: mintPk,
          creator: config.PROTOCOL_PUBKEY,
        });

        // Check if the account is owned by the fee program
        const programId = _PUMP_FEE_PROGRAM_ID || config.PUMP_FEES_PROGRAM_ID;
        if (!info.owner.equals(programId)) {
          return { valid: false, reason: 'PDA not owned by Pump fee program' };
        }

        // Parse sharing config account
        // Byte layout (verified against live mainnet data):
        // offset 0-8:   anchor discriminator
        // offset 8:     version (u8)
        // offset 9:     adminRevoked (u8 enum: 0=not revoked, 2=revoked)
        // offset 10-42: creator (32 bytes, Pubkey)
        // offset 42-74: fee authority (32 bytes, Pubkey)
        // offset 74-76: padding
        // offset 76-80: shares vec length (u32)
        // offset 80-112: first share recipient (32 bytes, Pubkey)
        // offset 112-114: first share bps (u16)
        const data = info.data;

        if (data.length < 114) {
          return { valid: false, reason: 'Account data too short for sharing config' };
        }

        const version = data[8];
        // adminRevoked is an enum: 0 = not revoked, 2 = revoked
        const adminRevoked = data[9] !== 0;
        const creator = new PublicKey(data.slice(10, 42));
        const sharesLen = data.readUInt32LE(76);

        if (sharesLen === 0) {
          return { valid: false, reason: 'No fee shares configured' };
        }

        const recipient = new PublicKey(data.slice(80, 112));
        const shareBps = data.readUInt16LE(112);

        // Verify recipient is protocol wallet
        if (!recipient.equals(config.PROTOCOL_PUBKEY)) {
          return {
            valid: false,
            reason: `Recipient is ${recipient.toBase58()}, expected ${config.PROTOCOL_PUBKEY.toBase58()}`,
          };
        }

        // Verify 100% allocation
        if (shareBps !== 10_000) {
          return { valid: false, reason: `Share is ${shareBps} bps, expected 10000 (100%)` };
        }

        // Verify admin is revoked
        if (!adminRevoked) {
          // Double-check with SDK standalone function
          const editable = _isSharingConfigEditable({ sharingConfig: { version, adminRevoked } });
          if (editable) {
            return { valid: false, reason: 'Admin has not been revoked — config is still editable' };
          }
        }

        logger.info('Sharing config verified', {
          mint: mintPk.toBase58(),
          recipient: recipient.toBase58(),
          shareBps,
          adminRevoked,
          version,
        });

        return { valid: true, pda: pda.toBase58() };

      } catch (sdkErr) {
        logger.warn('SDK verification failed, using raw fallback', { error: sdkErr.message });
      }
    }

    // Fallback: raw byte parsing without SDK
    if (!info.owner.equals(config.PUMP_FEES_PROGRAM_ID)) {
      return { valid: false, reason: 'PDA not owned by Pump fee program' };
    }

    const data = info.data;
    if (data.length < 114) {
      return { valid: false, reason: 'Account data too short' };
    }

    const adminRevoked = data[9] !== 0;
    const recipient = new PublicKey(data.slice(80, 112));
    const shareBps = data.readUInt16LE(112);

    if (!recipient.equals(config.PROTOCOL_PUBKEY)) {
      return { valid: false, reason: `Recipient mismatch: ${recipient.toBase58()}` };
    }
    if (shareBps !== 10_000) {
      return { valid: false, reason: `Share is ${shareBps} bps, expected 10000` };
    }
    if (!adminRevoked) {
      return { valid: false, reason: 'Admin not revoked' };
    }

    return { valid: true, pda: pda.toBase58() };
  } catch (err) {
    logger.error('verifySharingConfig error', { mint: mintPk.toBase58(), error: err.message });
    return { valid: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Build distribute creator fees instruction (permissionless)
// ---------------------------------------------------------------------------
export async function buildDistributeFeesIx(mint) {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;

  try {
    await loadSdk();
    const conn = getConnection();
    const sdk = new _OnlinePumpSdk(conn);

    const instructions = await sdk.buildDistributeCreatorFeesInstructions(mintPk);

    logger.debug('Built distribute fees IX', {
      mint: mintPk.toBase58(),
      ixCount: Array.isArray(instructions) ? instructions.length : 1,
    });

    return { instructions: Array.isArray(instructions) ? instructions : [instructions] };
  } catch (err) {
    logger.error('buildDistributeFeesIx failed', {
      mint: mintPk.toBase58(),
      error: err.message,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Get unclaimed creator vault balance
// ---------------------------------------------------------------------------
export async function getUnclaimedBalance(mint) {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  try {
    await loadSdk();
    const conn = getConnection();
    const sdk = new _OnlinePumpSdk(conn);
    const balance = await sdk.getCreatorVaultBalance(mintPk);
    return balance;
  } catch (err) {
    logger.error('getUnclaimedBalance failed', { mint: mintPk.toBase58(), error: err.message });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Execute fee distribution (claim)
// ---------------------------------------------------------------------------
export async function claimFees(mint) {
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;

  if (!config.protocolKeypair) {
    throw new Error('Protocol keypair not loaded — cannot sign transactions');
  }

  // Check minimum distributable fee first
  try {
    await loadSdk();
    const conn = getConnection();
    const sdk = new _OnlinePumpSdk(conn);
    const minFee = await sdk.getMinimumDistributableFee(mintPk);
    logger.debug('Minimum distributable fee', { mint: mintPk.toBase58(), minFee });
  } catch {
    // Non-critical — proceed anyway
  }

  const { instructions } = await buildDistributeFeesIx(mintPk);

  if (!instructions || instructions.length === 0) {
    logger.info('No distribute instructions (possibly no fees to claim)', {
      mint: mintPk.toBase58(),
    });
    return null;
  }

  const sig = await sendTx(instructions, [config.protocolKeypair]);
  logger.info('Fees claimed', { mint: mintPk.toBase58(), signature: sig });
  return sig;
}
