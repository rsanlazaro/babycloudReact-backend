import pool from '../db.js'; // Adjust path to your database connection

/**
 * Activity Types
 */
export const ACTIVITY_TYPES = {
  LOGIN: 'login',
  LOGOUT: 'logout',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
};

/**
 * Entity Types (modules)
 */
export const ENTITY_TYPES = {
  PROGESTOR: 'progestor',
  BABYSITE: 'babysite',
  RECLUTA: 'recluta',
  BABYCLOUD: 'babycloud',
};

/**
 * Log an activity to the database
 * 
 * @param {Object} params
 * @param {number} params.userId - ID of user performing the action
 * @param {string} params.activityType - Type: login, logout, create, update, delete
 * @param {string} params.entityType - Module: progestor, babysite, recluta, babycloud
 * @param {number|null} params.entityId - ID of affected record (optional)
 * @param {string} params.description - Human-readable description
 * @param {Object|null} params.metadata - Additional data as JSON (optional)
 * @param {Object} params.req - Express request object (for IP and user agent)
 */
export const logActivity = async ({
  userId,
  activityType,
  entityType,
  description,
  created_at,
  metadata = null,
}) => {
  try {
    // Convert metadata to JSON string if provided
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    await pool.query(
      `INSERT INTO activity_logs 
        (user_id, activity_type, entity_type, description, created_at, metadata) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, activityType, entityType, description, created_at, metadataJson]
    );

    return true;
  } catch (error) {
    // Log error but don't throw - logging shouldn't break main functionality
    console.error('Activity logging error:', error);
    return false;
  }
};

// ============================================
// HELPER FUNCTIONS FOR COMMON OPERATIONS
// ============================================

/**
 * Log a login event
 */
export const logLogin = async (userId, username, created_at, metadata = null) => {
  return logActivity({
    userId,
    activityType: ACTIVITY_TYPES.LOGIN,
    entityType: ENTITY_TYPES.PROGESTOR,
    description: `Usuario ${username} inició sesión`,
    created_at,
    metadata,
  });
};

/**
 * Log a logout event
 */
export const logLogout = async (userId, username, created_at, metadata = null) => {
  return logActivity({
    userId,
    activityType: ACTIVITY_TYPES.LOGOUT,
    entityType: ENTITY_TYPES.PROGESTOR,
    description: `Usuario ${username} cerró sesión`,
    created_at,
    metadata,
  });
};

/**
 * Log a create event
 */
export const logCreate = async (userId, entityType, description, created_at, metadata) => {
  return logActivity({
    userId,
    activityType: ACTIVITY_TYPES.CREATE,
    entityType,
    description,
    created_at,
    metadata,
  });
};

/**
 * Log an update event
 */
export const logUpdate = async (userId, entityType, description, created_at, metadata) => {
  return logActivity({
    userId,
    activityType: ACTIVITY_TYPES.UPDATE,
    entityType,
    description,
    created_at,
    metadata,
  });
};

/**
 * Log a delete event
 */
export const logDelete = async (userId, entityType, description, created_at, metadata) => {
  return logActivity({
    userId,
    activityType: ACTIVITY_TYPES.DELETE,
    entityType,
    description,
    created_at,
    metadata,
  });
};