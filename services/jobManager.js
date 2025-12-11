/**
 * Job Manager Service
 *
 * Simple in-memory job tracking for translation jobs.
 * Stores job status and results, allowing frontend to poll for updates.
 */

// In-memory storage for jobs
const jobs = new Map();

// Job statuses
const STATUS = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  TRANSCRIBING: 'transcribing',
  COMPLETE: 'complete',
  ERROR: 'error'
};

/**
 * Create a new job
 * @param {string} jobId - Unique job identifier
 * @param {string} youtubeUrl - The YouTube URL being processed
 * @returns {Object} The created job object
 */
function createJob(jobId, youtubeUrl) {
  const job = {
    id: jobId,
    youtubeUrl,
    status: STATUS.PENDING,
    progress: 0,
    transcript: null,
    duration: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, job);
  console.log(`[JOB MANAGER] Created job: ${jobId}`);

  return job;
}

/**
 * Get a job by ID
 * @param {string} jobId - The job ID to retrieve
 * @returns {Object|null} The job object or null if not found
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Update job status and progress
 * @param {string} jobId - The job ID to update
 * @param {string} status - New status
 * @param {number} progress - Progress percentage (0-100)
 */
function updateJob(jobId, status, progress) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = status;
    job.progress = progress;
    job.updatedAt = new Date().toISOString();
    console.log(`[JOB MANAGER] Updated job ${jobId}: ${status} (${progress}%)`);
  }
}

/**
 * Mark a job as complete with results
 * @param {string} jobId - The job ID to complete
 * @param {Array} transcript - The transcript segments
 * @param {number} duration - Video duration in seconds
 */
function completeJob(jobId, transcript, duration) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = STATUS.COMPLETE;
    job.progress = 100;
    job.transcript = transcript;
    job.duration = duration;
    job.updatedAt = new Date().toISOString();
    job.completedAt = new Date().toISOString();
    console.log(`[JOB MANAGER] Completed job ${jobId}`);
  }
}

/**
 * Mark a job as failed
 * @param {string} jobId - The job ID that failed
 * @param {string} errorMessage - Error message describing the failure
 */
function failJob(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = STATUS.ERROR;
    job.error = errorMessage;
    job.updatedAt = new Date().toISOString();
    console.log(`[JOB MANAGER] Failed job ${jobId}: ${errorMessage}`);
  }
}

/**
 * Delete a job (cleanup)
 * @param {string} jobId - The job ID to delete
 */
function deleteJob(jobId) {
  jobs.delete(jobId);
  console.log(`[JOB MANAGER] Deleted job ${jobId}`);
}

/**
 * Get all jobs (for debugging)
 * @returns {Array} Array of all jobs
 */
function getAllJobs() {
  return Array.from(jobs.values());
}

/**
 * Clean up old completed/failed jobs
 * Jobs older than the specified age (in minutes) will be deleted
 * @param {number} maxAgeMinutes - Maximum age in minutes (default: 60)
 */
function cleanupOldJobs(maxAgeMinutes = 60) {
  const now = new Date();
  let cleaned = 0;

  jobs.forEach((job, jobId) => {
    if (job.status === STATUS.COMPLETE || job.status === STATUS.ERROR) {
      const updatedAt = new Date(job.updatedAt);
      const ageMinutes = (now - updatedAt) / (1000 * 60);

      if (ageMinutes > maxAgeMinutes) {
        jobs.delete(jobId);
        cleaned++;
      }
    }
  });

  if (cleaned > 0) {
    console.log(`[JOB MANAGER] Cleaned up ${cleaned} old jobs`);
  }
}

// Run cleanup every 30 minutes
setInterval(() => cleanupOldJobs(60), 30 * 60 * 1000);

module.exports = {
  STATUS,
  createJob,
  getJob,
  updateJob,
  completeJob,
  failJob,
  deleteJob,
  getAllJobs,
  cleanupOldJobs
};
