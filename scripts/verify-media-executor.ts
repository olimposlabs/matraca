import { verifiedMediaExecutor } from '../server/media/executor.js';
const { image } = await verifiedMediaExecutor();
process.stdout.write(`FFmpeg 8.1.3 verificado em ${image}.\n`);
