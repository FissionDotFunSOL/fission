import winston from 'winston';

const { combine, timestamp, json, errors, colorize, printf } = winston.format;

const isDev = (process.env.NODE_ENV || 'development') === 'development';

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp: ts, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} ${level}: ${stack || message}${metaStr}`;
  }),
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  format: isDev ? devFormat : prodFormat,
  defaultMeta: { service: 'fission-backend' },
  transports: [new winston.transports.Console()],
});

export default logger;
