import React from 'react';
import { Job, JobStatus } from '@forgeflow/shared';
import { Eye, Ban, AlertCircle } from 'lucide-react';

interface JobTableProps {
  jobs: Job[];
  isLoading: boolean;
  onViewJob: (job: Job) => void;
  onCancelJob: (job: Job) => void;
}

export const JobTable: React.FC<JobTableProps> = ({
  jobs,
  isLoading,
  onViewJob,
  onCancelJob,
}) => {
  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case 'PENDING':
        return (
          <span className="badge badge-pending">
            <span className="badge-dot" />
            Pending
          </span>
        );
      case 'RUNNING':
        return (
          <span className="badge badge-running">
            <span className="badge-dot" />
            Running
          </span>
        );
      case 'COMPLETED':
        return (
          <span className="badge badge-completed">
            <span className="badge-dot" />
            Completed
          </span>
        );
      case 'FAILED':
        return (
          <span className="badge badge-failed">
            <span className="badge-dot" />
            Failed
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="badge badge-cancelled">
            <span className="badge-dot" />
            Cancelled
          </span>
        );
      default:
        return <span className="badge">{status}</span>;
    }
  };

  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  if (isLoading && jobs.length === 0) {
    return (
      <div className="table-empty">
        <div style={{ marginBottom: '0.5rem' }}>Loading jobs...</div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="table-empty">
        <AlertCircle size={36} color="#6b7280" style={{ marginBottom: '0.75rem' }} />
        <h4 style={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
          No jobs found
        </h4>
        <p style={{ fontSize: '0.8125rem' }}>
          Submit a new job using the button above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table className="table">
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Type</th>
            <th>Status</th>
            <th>Payload Preview</th>
            <th>Created At</th>
            <th style={{ textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <span className="font-mono" style={{ fontSize: '0.8125rem', color: '#93c5fd' }}>
                  {job.id.slice(0, 8)}...
                </span>
              </td>
              <td>
                <span className="badge badge-type">{job.type}</span>
              </td>
              <td>{getStatusBadge(job.status)}</td>
              <td>
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontFamily: 'JetBrains Mono',
                    fontSize: '0.75rem',
                    display: 'inline-block',
                    maxWidth: '200px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={JSON.stringify(job.payload)}
                >
                  {JSON.stringify(job.payload)}
                </span>
              </td>
              <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                {formatDate(job.createdAt)}
              </td>
              <td style={{ textAlign: 'right' }}>
                <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onViewJob(job)}
                    title="View full job details"
                  >
                    <Eye size={13} />
                    <span>View</span>
                  </button>

                  {job.status === 'PENDING' && (
                    <button
                      className="btn btn-danger-outline btn-sm"
                      onClick={() => onCancelJob(job)}
                      title="Cancel this pending job"
                    >
                      <Ban size={13} />
                      <span>Cancel</span>
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
