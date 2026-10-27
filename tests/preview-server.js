// Manual UI QA with disposable in-memory data. No connection to MongoDB Atlas.
import './helpers/memory-db.js';
process.env.MONGODB_URI = 'mongodb://localhost:27017/ui-test';
process.env.INITIAL_ADMIN_PASSWORD = 'test-password';
process.env.PORT = '8766';
await import('../server.js');
