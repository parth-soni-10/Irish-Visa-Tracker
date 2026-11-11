# Implementation Plan: Features 1, 4, 5 + Detailed Plan for 6

> **Status — 2026-11-11.** Features 1, 4 and 5 are implemented and verified in the current tree. Native mobile (section 6) is **deferred**: the installable PWA is the supported mobile product. The detailed section is retained as a future option, not current scope. See `COMPLETION_REPORT.md` and `GAP_ANALYSIS.md` for the live record.

## 1. User Accounts + Saved Watchlists (Medium)

### 1.1 Database Schema (D1)
```sql
-- Users table (extends existing schema)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_hash TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  preferences TEXT DEFAULT '{}', -- JSON: theme, language, notifications, timezone
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- User sessions (for JWT/cookie management)
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Watchlists (persisted across devices)
CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy_slug TEXT NOT NULL,
  nickname TEXT,
  notify_email BOOLEAN DEFAULT 1,
  notify_push BOOLEAN DEFAULT 1,
  notify_whatsapp BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Push subscriptions (Web Push VAPID)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Private export tokens (workspace-only downloads; no public API)
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT DEFAULT '["export"]', -- JSON array; production uses ["export"] for private downloads
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked BOOLEAN DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Admin tokens (for admin dashboard)
CREATE TABLE IF NOT EXISTS admin_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked BOOLEAN DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email subscriptions (decision alerts)
CREATE TABLE IF NOT EXISTS email_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT, -- nullable for anonymous subscriptions
  email_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy_slug TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  verification_token TEXT,
  verification_expires TEXT,
  unsubscribed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_alert_sent TEXT
);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verifications (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  type TEXT NOT NULL, -- 'registration', 'subscription', 'password_reset'
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 1.2 Auth Module (`functions/auth.js`)
```javascript
// Password hashing (PBKDF2)
async function hashPassword(password) { ... }
async function verifyPassword(password, hash) { ... }

// Session management
async function createSession(env, userId) { ... }
async function validateSession(env, sessionId) { ... }
async function deleteSession(env, sessionId) { ... }

// JWT tokens for API access
async function createAPIToken(env, userId, name, scopes) { ... }
async function validateAPIToken(env, token) { ... }

// Password reset flow
async function requestPasswordReset(env, email) { ... }
async function resetPassword(env, token, newPassword) { ... }

// Email verification
async function sendVerificationEmail(env, email, type) { ... }
async function verifyEmail(env, token) { ... }
```

### 1.3 User API Routes (`functions/user-api.js`)
```javascript
// POST /api/auth/register - Register new user
// POST /api/auth/login - Login (returns session cookie)
// POST /api/auth/logout - Logout
// GET /api/auth/me - Get current user
// PUT /api/auth/profile - Update profile (name, preferences)
// PUT /api/auth/password - Change password
// DELETE /api/auth/delete - Delete account
// POST /api/auth/password/reset - Request password reset
// POST /api/auth/password/reset/confirm - Confirm password reset

// Watchlist management
// GET /api/user/watchlist - Get user's watchlist
// POST /api/user/watchlist - Add to watchlist
// DELETE /api/user/watchlist/:appNumber - Remove from watchlist

// Push notifications
// POST /api/user/push/subscribe - Subscribe to push
// DELETE /api/user/push/subscribe - Unsubscribe

// Private export tokens (workspace only; the public API was retired)
// GET /api/portal/export-tokens - List private export tokens
// POST /api/portal/export-tokens - Create a private export token
// DELETE /api/portal/export-tokens?id= - Revoke a private export token
```

### 1.4 Frontend Integration
- Add "Sign In / Sign Up" to landing page and tracker headers
- User dropdown menu (profile, settings, watchlist, workspace, sign out)
- Watchlist UI on Home/Past tabs (already have watch infrastructure, persist to D1)
- Protected routes for authenticated features
- Session persistence via HttpOnly cookie + localStorage fallback

---

## 4. Sentry Error Tracking (Low)

### 4.1 Installation
```bash
npm install @sentry/cloudflare
```

### 4.2 Sentry Configuration (`functions/sentry.js`)
```javascript
import * as Sentry from "@sentry/cloudflare";

export function initSentry(env) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT || 'production',
    release: env.COMMIT_SHA || 'unknown',
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    integrations: [
      new Sentry.Integrations.HttpClient(),
    ],
    beforeSend(event, hint) {
      // Filter out known benign errors
      if (event.exception) {
        const error = hint.originalException;
        if (error?.message?.includes('Network request failed')) {
          return null; // Drop network errors
        }
      }
      return event;
    },
  });
}

export function captureException(error, context = {}) {
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
    Sentry.captureException(error);
  });
}

export function setUserContext(user) {
  Sentry.setUser({
    id: user.id,
    email: user.email,
    username: user.name,
  });
}
```

### 4.3 Integration in Router (`functions/_router.js`)
```javascript
import { initSentry, captureException, setUserContext } from "./sentry.js";

export default {
  async fetch(request, env) {
    initSentry(env);
    
    try {
      // ... existing router logic
    } catch (error) {
      captureException(error, {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
      });
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  async scheduled(controller, env, ctx) {
    initSentry(env);
    // ... scheduled handler
  }
};
```

### 4.3 Frontend Error Tracking (`index.html`)
```html
<script>
  // Initialize Sentry on client side
  if (window.Sentry) {
    Sentry.init({
      dsn: 'YOUR_SENTRY_DSN',
      environment: 'production',
      tracesSampleRate: 0.1,
      beforeSend(event) {
        // Filter out known benign errors
        if (event.exception) {
          const error = event.exception.values?.[0];
          if (error?.value?.includes('Network request failed')) return null;
        }
        return event;
      }
    });
  }
  
  // Global error handler
  window.addEventListener('error', (e) => {
    if (window.Sentry) Sentry.captureException(e.error);
  });
  
  window.addEventListener('unhandledrejection', (e) => {
    if (window.Sentry) Sentry.captureException(e.reason);
  });
</script>
<script src="https://browser.sentry-cdn.com/7.100.0/bundle.min.js" integrity="sha384-..." crossorigin="anonymous"></script>
```

### 4.4 Sentry Setup Checklist
- [ ] Create Sentry project
- [ ] Add `SENTRY_DSN` to Cloudflare Pages secrets
- [ ] Add `SENTRY_AUTH_TOKEN` for source maps upload
- [ ] Configure source maps upload in build pipeline
- [ ] Set up alerts for error spikes
- [ ] Configure release tracking

---

## 5. ML Timeline Predictor (High)

### 5.1 Architecture
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Data Pipeline  │────▶│  Feature Eng.   │────▶│  Model Training │
│  (Historical)   │     │  (Features)     │     │  (XGBoost/LGBM) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Model Serving  │
                                                │  (ONNX/TensorFlow│
                                                │   JS / Worker)  │
                                                └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  API Endpoint   │
                                                │  /api/predict   │
                                                └─────────────────┘
```

### 5.2 Features for Training
```javascript
// Features per application
const features = {
  // Application metadata
  application_number: Number,
  embassy_slug: String,        // Categorical: new-delhi, beijing, etc.
  visa_type: String,           // Categorical: study, work, visit, family, transit
  
  // Temporal features
  applied_month: Number,       // 1-12
  applied_day_of_week: Number, // 0-6
  applied_week_of_year: Number,// 1-52
  applied_quarter: Number,     // 1-4
  
  // Embassy-specific stats (rolling windows)
  embassy_30d_approval_rate: Number,
  embassy_30d_volume: Number,
  embassy_7d_avg_volume: Number,
  embassy_volume_trend: Number,      // slope of last 7 days
  
  // Global stats
  global_30d_approval_rate: Number,
  global_volume_trend: Number,
  
  // Seasonal
  is_peak_season: Boolean,     // May-Aug, Dec
  is_holiday_period: Boolean,  // Major holidays
  
  // Application number features
  app_number_mod_100: Number,  // application_number % 100
  app_number_mod_1000: Number, // application_number % 1000
  app_number_bucket: String,   // e.g., "86000000-86999999"
  
  // Lag features (if historical data available)
  lag_1d: Number,
  lag_7d: Number,
  lag_30d: Number,
};
```

### 5.3 Model Training Pipeline (Python/Colab)
```python
# training_pipeline.py
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
import mlflow

def load_data():
    # Load from data/embassy-*.json files
    # Combine all embassies, create target: days_to_decision
    pass

def engineer_features(df):
    # Feature engineering from section 5.2
    pass

def train_model(X_train, y_train, X_val, y_val):
    params = {
        'objective': 'reg:squarederror',
        'eval_metric': 'mae',
        'max_depth': 6,
        'learning_rate': 0.1,
        'subsample': 0.8,
        'colsample_bytree': 0.8,
        'n_estimators': 500,
        'early_stopping_rounds': 50,
        'random_state': 42,
    }
    
    model = xgb.XGBRegressor(**params)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=50
    )
    return model

def evaluate(model, X_test, y_test):
    preds = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    return {'mae': mae, 'rmse': rmse}

def export_onnx(model, path):
    import onnx
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    
    initial_type = [('float_input', FloatTensorType([None, n_features]))]
    onnx_model = convert_sklearn(model, initial_types=initial_type)
    with open(path, 'wb') as f:
        f.write(onnx_model.SerializeToString())
```

### 5.4 Model Serving (Cloudflare Worker)
```javascript
// functions/api/predict.js
import * as ort from 'onnxruntime-web';

let session = null;

async function loadModel(env) {
  if (session) return session;
  const modelResp = await fetch(new URL('/models/timeline_model.onnx', request.url));
  const modelBuffer = await modelResp.arrayBuffer();
  session = await ort.InferenceSession.create(modelBuffer);
  return session;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  
  const { visa_type, embassy, application_date, application_number } = body;
  
  // Feature engineering
  const features = engineerFeatures(body);
  const input = new Float32Array([Object.values(features)]);
  
  const session = await loadModel(env);
  const inputTensor = new ort.Tensor('float32', input, [1, n_features]);
  
  const results = await session.run({ 'float_input': inputTensor });
  const prediction = results.output.data[0]; // days to decision
  
  const decisionDate = new Date(body.application_date);
  decisionDate.setDate(decisionDate.getDate() + Math.round(prediction));
  
  return new Response(JSON.stringify({
    predicted_days: Math.round(prediction),
    estimated_decision_date: decisionDate.toISOString().split('T')[0],
    confidence_interval: calculateCI(prediction), // from model uncertainty
    model_version: '1.0.0',
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 5.5 Deployment Steps
1. **Data Export**: Export historical data from `data/embassy-*.json`
2. **Train Model**: Run training pipeline in Colab/Vertex AI
3. **Export ONNX**: Convert to ONNX format
4. **Deploy Model**: Upload `.onnx` to Cloudflare R2 or Workers KV
5. **Deploy Worker**: Add `/functions/api/predict.js` endpoint
6. **Frontend Integration**: Add "Predict" button to Home/1G/Permits tabs

---

## 6. Native Mobile Apps (Very High) - DETAILED PLAN

### 6.1 Technology Stack Decision

| Approach | Pros | Cons | Recommendation |
|----------|------|------|----------------|
| **React Native (Expo)** | Code sharing with web, Expo managed workflow, OTA updates | Large bundle, native module complexity | ✅ **RECOMMENDED** |
| **React Native (Bare)** | Full native access, smaller bundle | Manual native config, Xcode/Android Studio needed | Alternative |
| **Capacitor/Ionic** | Web code reuse, capacitor plugins | Performance overhead, WebView limitations | Good fallback |
| **Flutter** | Performance, single codebase | Dart learning curve, less web code reuse | Future consideration |
| **PWA + TWA** | Simplest, share codebase | Limited native APIs, no push on iOS | MVP only |

**Decision: React Native with Expo (Managed → Bare workflow)**

### 6.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     SHARED CODEBASE                              │
├─────────────────┬─────────────────┬─────────────────────────────┤
│      Web        │   Mobile App    │         Shared              │
│  (React/Next)   │  (React Native) │     (Packages)              │
├─────────────────┼─────────────────┼─────────────────────────────┤
│                 │                 │  @visa-tracker/api          │
│  - index.html   │  - App.tsx      │    - api.ts (fetch wrapper) │
│  - components/  │  - screens/     │    - types.ts (Zod schemas) │
│  - hooks/       │  - components/  │    - utils.ts               │
│  - utils/       │  - navigation/  │    - constants.ts           │
│                 │  - hooks/       │    - validators.ts          │
│                 │  - store/       │                             │
├─────────────────┴─────────────────┴─────────────────────────────┤
│                    BUILD & DEPLOY                                │
│  Web: Cloudflare Pages    │  iOS: EAS Build → TestFlight → App Store  │
│                           │  Android: EAS Build → Play Console      │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Monorepo Structure (Nx/Turborepo)
```
visa-tracker/
├── apps/
│   ├── web/                 # Cloudflare Pages (existing)
│   │   ├── src/
│   │   ├── public/
│   │   ├── package.json
│   │   └── wrangler.toml
│   │
│   └── mobile/              # Expo React Native
│       ├── app/             # Expo Router (file-based routing)
│       │   ├── _layout.tsx
│       │   ├── index.tsx           # Landing → Tracker selection
│       │   ├── (tabs)/
│       │   │   ├── _layout.tsx     # Tab navigator
│       │   │   ├── visa.tsx        # Visa tracker (Home/Daily/Past/Analytics/Suggest)
│       │   │   ├── 1g.tsx          # Stamp 1G tracker
│       │   │   │   ├── estimator.tsx
│       │   │   ├── permits.tsx     # Employment permits
│       │   │   ├── alerts.tsx      # Alerts/Watchlist
│       │   │   ├── profile.tsx     # User profile, settings
│       │   │   └── admin.tsx       # Admin (if admin)
│       │   ├── auth/
│       │   │   ├── login.tsx
│       │   │   ├── register.tsx
│       │   │   └── verify.tsx
│       │   └── settings.tsx
│       │
│       ├── components/
│       │   ├── ui/              # Shared UI primitives
│       │   ├── visa/            # Visa-specific components
│       │   ├── forms/           # Form components
│       │   └── charts/          # Chart wrappers
│       │
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   ├── useVisaData.ts
│       │   ├── useWatchlist.ts
│       │   ├── usePushNotifications.ts
│       │   └── useOfflineSync.ts
│       │
│       ├── services/
│       │   ├── api.ts           # API client (shared)
│       │   ├── auth.ts          # Auth service
│       │   ├── push.ts          # Push notifications
│       │   ├── storage.ts       # Secure storage (MMKV)
│       │   ├── offline.ts       # Offline queue (WatermelonDB/SQLite)
│       │   └── analytics.ts     # PostHog/Amplitude
│       │
│       ├── store/
│       │   ├── index.ts         # Zustand/Redux Toolkit store
│       │   ├── authSlice.ts
│       │   ├── visaSlice.ts
│       │   └── settingsSlice.ts
│       │
│       ├── utils/
│       ├── constants/
│       ├── types/
│       ├── app.config.ts        # Expo config
│       ├── eas.json             # EAS Build config
│       └── package.json
│
├── packages/
│   ├── api/              # Shared API client & types
│   │   ├── src/
│   │   │   ├── client.ts       # Fetch wrapper with auth
│   │   │   ├── endpoints.ts    # Endpoint definitions
│   │   │   ├── schemas.ts      # Zod schemas
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── ui/               # Shared UI components (React Native Web compatible)
│   │   ├── src/
│   │   │   ├── primitives/   # Box, Text, Button, Input, Card, etc.
│   │   │   ├── forms/        # Form components
│   │   │   ├── charts/       # Chart wrappers (recharts/victory native)
│   │   │   ├── calendar/     # Calendar picker (shared logic)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── types/            # Shared TypeScript types + Zod schemas
│   │   ├── src/
│   │   │   ├── visa.ts
│   │   │   ├── user.ts
│   │   │   ├── alerts.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── utils/            # Shared utilities
│       ├── src/
│       │   ├── date.ts
│       │   ├── format.ts
│       │   ├── validation.ts
│       │   └── index.ts
│       └── package.json
│
├── turbo.json            # Turborepo config
├── package.json          # Root package.json (workspaces)
├── tsconfig.base.json    # Base TS config
└── README.md
```

### 6.4 Core Features Implementation

#### 6.4.1 Authentication Flow
```typescript
// packages/api/src/auth.ts
export const authApi = {
  register: (data: RegisterInput) => api.post('/api/auth/register', data),
  login: (credentials: LoginInput) => api.post('/api/auth/login', credentials),
  logout: () => api.post('/api/auth/logout'),
  me: () => api.get('/api/auth/me'),
  updateProfile: (data: Partial<User>) => api.put('/api/auth/profile', data),
  changePassword: (data: { current: string; new: string }) => api.put('/api/auth/password', data),
  deleteAccount: () => api.delete('/api/auth/delete'),
  requestPasswordReset: (email: string) => api.post('/api/auth/password/reset', { email }),
  resetPassword: (token: string, password: string) => api.post('/api/auth/password/reset/confirm', { token, password }),
};
```

#### 6.4.2 Offline-First Data Layer (WatermelonDB)
```typescript
// apps/mobile/services/offline.ts
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import { schema } from './schema';
import { VisaDecision } from './models/VisaDecision';
import { WatchlistItem } from './models/WatchlistItem';
import { CommunityTimeline } from './models/CommunityTimeline';
import { PermitData } from './models/PermitData';
import { User } from './models/User';

const adapter = new SQLiteAdapter({
  schema,
  dbName: 'visa_tracker.db',
  onSetupError: (error) => console.error('DB setup error:', error),
});

export const database = new Database({
  adapter,
  modelClasses: [VisaDecision, WatchlistItem, CommunityTimeline, PermitData, User],
});

export const synchronize = async (api: ApiClient) => {
  // Pull latest data
  const [visaData, g1Data, permitsData, communityData] = await Promise.all([
    api.get('/data/visa_decisions.json'),
    api.get('/data/stamp_1g.json'),
    api.get('/data/work_permits.json'),
    api.get('/data/community_timelines.json'),
  ]);

  // Write to local DB
  await database.write(async () => {
    await Promise.all([
      batchUpsert(VisaDecision.table, visaData),
      batchUpsert(WatchlistItem.table, watchlistData),
      // ...
    ]);
  });

  // Push pending changes
  const pending = await database.collections.get('outbox').query().fetch();
  for (const op of pending) {
    await api.request(op.method, op.endpoint, op.payload);
    await op.destroyPermanently();
  }
};

// Auto-sync every 30 min when online
setInterval(() => {
  if (NetInfo.isConnected.fetch()) synchronize(api);
}, 30 * 60 * 1000);
```

#### 6.4.3 Push Notifications (Expo + Web Push)
```typescript
// apps/mobile/services/push.ts
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications(userId: string) {
  if (!Device.isDevice) return;
  
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    const { status: newStatus } = await Notifications.requestPermissionsAsync();
    if (newStatus !== 'granted') return;
  }
  
  const token = (await Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig?.extra?.eas?.projectId,
  })).data;

  await api.post('/api/user/push/subscribe', {
    token,
    platform: Platform.OS,
    deviceId: Device.getDeviceId(),
  });

  // Also register Web Push for web compatibility
  if (Platform.OS === 'web') {
    await registerWebPush();
  }
}

export async function handleDecisionAlert(decision: VisaDecision) {
  await Notifications.scheduleNotificationAsync({
    title: `Visa Decision: ${decision.decision}`,
    body: `Application ${decision.number} was ${decision.decision.toLowerCase()} on ${decision.date}`,
    data: { type: 'decision', applicationNumber: decision.number, embassy: decision.embassy },
    sound: true,
    priority: Notifications.AndroidImportance.HIGH,
  });
}
```

### 6.5 Navigation Structure (Expo Router)
```typescript
// apps/mobile/app/_layout.tsx
export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="auth/login" options={{ headerShown: false }} />
      <Stack.Screen name="auth/register" options={{ headerShown: false }} />
      <Stack.Screen name="auth/verify" options={{ headerShown: false }} />
      
      <Tabs screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="(tabs)/visa" options={{ title: 'Visa' }} />
        <Tabs.Screen name="(tabs)/1g" options={{ title: 'Stamp 1G' }} />
        <Tabs.Screen name="(tabs)/permits" options={{ title: 'Permits' }} />
        <Tabs.Screen name="(tabs)/alerts" options={{ title: 'Alerts' }} />
        <Tabs.Screen name="(tabs)/profile" options={{ title: 'Profile' }} />
      </Tabs>
      
      <Stack.Screen name="visa/[id]" options={{ title: 'Application Details' }} />
      <Stack.Screen name="estimator" options={{ title: 'Processing Estimator' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
    </Stack>
  );
}
```

### 6.6 Shared UI Components (packages/ui)
```typescript
// packages/ui/src/primitives/Button.tsx
export const Button = ({ variant = 'primary', size = 'md', children, ...props }) => (
  <Pressable
    style={[
      styles.base,
      styles[variant],
      styles[size],
      props.style
    ]}
    onPress={props.onPress}
    disabled={props.disabled}
    accessibilityRole="button"
    {...props}
  >
    <Text style={textStyles[variant]}>{props.children}</Text>
  </Pressable>
);

// Platform-specific styles
const styles = StyleSheet.create({
  base: {
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  primary: { backgroundColor: '#059669' },
  secondary: { backgroundColor: '#f4f4f5', borderWidth: 1, borderColor: '#e5e7eb' },
  outline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#059669' },
  ghost: { backgroundColor: 'transparent' },
  sm: { paddingVertical: 8, paddingHorizontal: 12 },
  md: { paddingVertical: 12, paddingHorizontal: 20 },
  lg: { paddingVertical: 16, paddingHorizontal: 24 },
};
```

### 6.7 CI/CD Pipeline (GitHub Actions + EAS)
```yaml
# .github/workflows/ci.yml
name: CI/CD

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build

  web-deploy:
    needs: lint-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
      - run: npx wrangler pages deploy ./apps/web --project-name=irish-visa-tracker

  mobile-build:
    needs: lint-test
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop'
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: expo/expo-github-action@v8
      - run: cd apps/mobile && npx eas build --platform all --profile production --non-interactive
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
          EAS_PROJECT_ID: ${{ secrets.EAS_PROJECT_ID }}

  mobile-submit:
    needs: mobile-build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: expo/expo-github-action@v8
      - run: cd apps/mobile && npx eas submit --platform all --profile production --non-interactive
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
          EAS_PROJECT_ID: ${{ secrets.EAS_PROJECT_ID }}
          APP_STORE_CONNECT_API_KEY: ${{ secrets.APP_STORE_CONNECT_API_KEY }}
          GOOGLE_PLAY_SERVICE_ACCOUNT: ${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT }}
```

### 6.8 EAS Build Configuration (`eas.json`)
```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "resourceClass": "m-medium" },
      "android": { "buildType": "apk" }
    },
    "preview": {
      "distribution": "internal",
      "ios": { "resourceClass": "m-medium", "simulator": false },
      "android": { "buildType": "aab" }
    },
    "production": {
      "ios": {
        "resourceClass": "m-medium",
        "simulator": false,
        "credentialsSource": "remote",
        "bundleIdentifier": "com.parthsoni.irishvisatracker"
      },
      "android": {
        "buildType": "aab",
        "credentialsSource": "remote",
        "packageName": "com.parthsoni.irishvisatracker"
      }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "parth.soni.parth@gmail.com",
        "ascAppId": "1234567890",
        "appleTeamId": "ABCDE12345"
      },
      "android": {
        "serviceAccountKeyPath": "./google-play-service-account.json",
        "track": "production"
      }
    }
  }
}
```

### 6.9 App Store Assets Checklist
| Asset | iOS | Android | Status |
|-------|-----|---------|--------|
| App Icon (1024x1024) | ✅ | ✅ | 📋 |
| Launch Screen | ✅ | ✅ | 📋 |
| App Store Screenshots (6.5", 5.5") | ✅ | - | 📋 |
| Play Store Screenshots (Phone, Tablet) | - | ✅ | 📋 |
| Feature Graphic (1024x500) | - | ✅ | 📋 |
| App Store Description | ✅ | ✅ | 📋 |
| Privacy Policy URL | ✅ | ✅ | ✅ |
| Support URL | ✅ | ✅ | ✅ |
| Age Rating | ✅ | ✅ | ✅ |

### 6.10 Timeline Estimate
| Phase | Duration | Milestone |
|-------|----------|-----------|
| **Setup & Foundation** | 2 weeks | Monorepo, shared packages, auth, API client |
| **Core Screens** | 3 weeks | Landing, Visa/1G/Permits tabs, navigation |
| **Offline & Sync** | 2 weeks | WatermelonDB, background sync, conflict resolution |
| **Push & Alerts** | 1 week | Expo notifications, Web Push parity |
| **Profile & Settings** | 1 week | Auth, profile, watchlist, private exports |
| **Testing & Polish** | 2 weeks | E2E tests, accessibility, performance |
| **App Store Prep** | 1 week | Screenshots, metadata, privacy policy |
| **Store Submission** | 1 week | TestFlight, Play Console, review |
| **Total** | **~13 weeks** | **MVP Launch** |

### 6.11 Resource Requirements
| Role | Allocation |
|------|------------|
| Mobile Lead (React Native) | 1.0 FTE |
| Mobile Engineer | 1.0 FTE |
| Backend/DevOps (shared) | 0.5 FTE |
| QA/Testing | 0.5 FTE |
| Design (part-time) | 0.25 FTE |

### 6.12 Risk Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| App Store rejection | Medium | High | Pre-submission checklist, TestFlight beta |
| Expo SDK limitations | Low | Medium | Eject to bare workflow if needed |
| Push notification delays | Medium | Medium | Fallback to email, in-app banner |
| Offline sync conflicts | Medium | High | Last-write-wins + user merge UI |
| iOS/Android parity | Medium | Medium | Platform-specific components where needed |

---

## Summary: Implementation Order

### Phase 1 (Weeks 1-4): Foundation
1. ✅ **User Accounts + Watchlists** - D1 schema, auth routes, frontend auth UI
2. ✅ **Sentry Integration** - Worker + frontend, source maps, alerts
3. 🔄 **ML Timeline Predictor** - Data export → Colab training → ONNX export → Worker endpoint

### Phase 2 (Weeks 5-8): Mobile Foundation
1. Monorepo setup (Turborepo + Expo)
2. Shared packages (api, ui, types, utils)
3. Authentication flow (login, register, JWT)
4. Core screens (Home, Visa, 1G, Permits, Alerts, Profile)

### Phase 3 (Weeks 9-14): Core Mobile Features
1. Offline-first data layer (WatermelonDB)
2. Push notifications (Expo + Web Push parity)
4. Watchlist sync across devices
5. Document checklist generator

### Phase 4 (Weeks 15-18): Launch Prep
1. ML Timeline Predictor (ONNX + Worker endpoint)
2. Native iOS/Android builds (EAS)
3. App Store / Play Store submission
3. Monitoring (Sentry + analytics)

### Phase 5 (Post-Launch)
1. ML model retraining pipeline
2. Native push reliability improvements
3. Appointment slot monitoring (VFS Global API)
4. White-label / consultant features