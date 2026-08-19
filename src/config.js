require('dotenv').config();

module.exports = {
  DEFAULT_COURSE_URL: process.env.DEFAULT_COURSE_URL || 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=263837700&clazzid=147110605&cpi=517019981&enc=1c0c74b9a48543e4ae307613f2ebf9ad&t=1787037581265&pageHeader=1',
  MAX_LESSONS: parseInt(process.env.MAX_LESSONS || '20', 10),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),
  DAEMON_MODE: process.env.DAEMON_MODE === 'true'
};
