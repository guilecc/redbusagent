import { TaskScheduler } from './core/scheduler.js';
console.log('TaskScheduler imported.');
TaskScheduler.init(null, null);
TaskScheduler.scheduleTask('*/5 * * * *', 'test');
console.log('List tasks:', TaskScheduler.listScheduledTasks());
TaskScheduler.stopAll();
process.exit(0);
