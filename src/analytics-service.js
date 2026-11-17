function getLocalDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function getTimestampDateKey(timestamp) {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : getLocalDateKey(date);
}

function validateWeekDates(weekDates) {
  if (!Array.isArray(weekDates) || weekDates.length === 0 || !weekDates.every((date) => date instanceof Date)) {
    throw new TypeError('Week dates must be a non-empty list of Date values.');
  }
}

function summarizeTaskAnalytics(tasks, options) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('Tasks must be a list.');
  }
  if (!options || typeof options.today !== 'string') {
    throw new TypeError('A today date key is required.');
  }
  const { today, weekDates } = options;
  validateWeekDates(weekDates);
  const weekDateKeys = weekDates.map(getLocalDateKey);
  const lastDay = weekDateKeys.at(-1);
  const weekDateSet = new Set(weekDateKeys);
  const taskWeekCounts = Object.fromEntries(weekDateKeys.map((dateKey) => [dateKey, 0]));
  const weeklyTaskPool = new Set();
  let todayTaskCount = 0;
  let tasksCompletedToday = 0;
  let completedTodayTasksCreatedToday = 0;
  let pendingTasks = 0;
  let weeklyCompletedTaskCount = 0;

  for (const task of tasks) {
    if (task.skipped) continue;
    const createdDate = task.recurrence ? task.dueDate : getTimestampDateKey(task.createdAt);
    const completedDate = task.completed ? getTimestampDateKey(task.completedAt) : null;
    if (createdDate === today) {
      todayTaskCount += 1;
      if (completedDate === today) {
        completedTodayTasksCreatedToday += 1;
      }
    }
    if (completedDate === today) {
      tasksCompletedToday += 1;
    }
    if (!task.completed) {
      pendingTasks += 1;
    }
    if (completedDate && weekDateSet.has(completedDate)) {
      weeklyCompletedTaskCount += 1;
      weeklyTaskPool.add(task.id);
      taskWeekCounts[completedDate] += 1;
    }
    if (!task.completed && createdDate && createdDate <= lastDay) {
      weeklyTaskPool.add(task.id);
    }
  }

  return {
    todayTaskCount,
    tasksCompletedToday,
    completedTodayTasksCreatedToday,
    pendingTasks,
    weeklyCompletedTaskCount,
    weeklyTaskPoolSize: weeklyTaskPool.size,
    taskWeekCounts,
  };
}

function summarizeActivityAnalytics(activities, options) {
  if (!Array.isArray(activities)) {
    throw new TypeError('Activities must be a list.');
  }
  if (!options || typeof options.today !== 'string') {
    throw new TypeError('A today date key is required.');
  }
  const { today } = options;
  let todayActivityCount = 0;
  let activitiesCompletedToday = 0;
  let completedScheduledToday = 0;

  for (const activity of activities) {
    if (activity.skipped) continue;
    const completedDate = activity.completed ? getTimestampDateKey(activity.completedAt) : null;
    if (activity.date === today) {
      todayActivityCount += 1;
      if (completedDate === today) {
        completedScheduledToday += 1;
      }
    }
    if (completedDate === today) {
      activitiesCompletedToday += 1;
    }
  }

  return {
    todayActivityCount,
    activitiesCompletedToday,
    completedScheduledToday,
  };
}

const analyticsService = {
  getLocalDateKey,
  getTimestampDateKey,
  summarizeActivityAnalytics,
  summarizeTaskAnalytics,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = analyticsService;
}

if (typeof globalThis !== 'undefined') {
  globalThis.taskForgeAnalytics = analyticsService;
}
