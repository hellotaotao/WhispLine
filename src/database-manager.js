const { default: Store } = require("electron-store");

class DatabaseManager {
  constructor() {
    this.store = new Store({
      name: 'transcription-history',
      defaults: {
        activities: []
      }
    });
  }

  addActivity(text, success = true, error = null) {
    const activity = {
      id: Date.now().toString(),
      text: text,
      timestamp: new Date().toISOString(),
      success: success,
      error: error
    };

    const activities = this.store.get('activities');
    activities.unshift(activity);
    
    // Keep only last 100 activities
    if (activities.length > 100) {
      activities.splice(100);
    }
    
    this.store.set('activities', activities);
    return activity;
  }

  getActivities() {
    return this.store.get('activities');
  }
}

module.exports = DatabaseManager;
