import 'dotenv/config';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';

import express from 'express';
import cors from 'cors';

import userRoutes from './routes/user.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import authRoutes from './routes/auth.routes.js';
import logsRoutes from './routes/logs.routes.js';

const app = express();

const isProduction = process.env.NODE_ENV === 'production';

let store;

if (isProduction) {
  const redisClient = createClient({
    url: process.env.REDIS_URL,
  });

  redisClient.connect().catch(console.error);

  store = new RedisStore({
    client: redisClient,
  });
}

app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://babycloud.netlify.app',
  ],
  credentials: true,
}));

app.use(express.json());

app.set('trust proxy', 1);

app.use(
  session({
    store: isProduction ? store : undefined,
    name: 'babycloud.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,                 // true only on HTTPS
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60 * 24,
    }
  })
);

app.use((req, res, next) => {
  next();
});

// routes
app.use('/api/users', userRoutes);
app.use("/api/upload", uploadRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/logs', logsRoutes);
app.listen(4000, () => console.log("Server running"));