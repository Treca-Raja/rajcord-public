import { checkVoiceTestServices } from './test-services.js';
try {
  await checkVoiceTestServices();
  console.log('Voice test services ready: PostgreSQL and LiveKit.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
