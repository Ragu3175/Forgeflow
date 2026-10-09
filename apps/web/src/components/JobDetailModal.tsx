import React from 'react';
import { Job } from '@forgeflow/shared';
import { X, Copy, Ban, Check } from 'lucide-react';

interface JobDetailModalProps {
  job: Job | null;
  isOpen: boolean;
  onClose: () => void;
  onCancelJob: (job: Job) => void;
}

export const JobDetailModal: React.FC<JobDetailModalProps> = ({
  job,
  isOpen,
  onClose,
  onCancelJob,
}) => {
  const [copied, setCopied] = React.useState(false);

  if (!isOpen || !job) return null;

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(job.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content modal-content-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h3 className="modal-title">Job Details</h3>
            <span className="badge badge-type">{job.type}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <div>
              <div className="form-label">Job ID</div>
              <div
                className="font-mono"
                style={{
                  fontSize: '0.8125rem',
                  color: 'var(--text-primary)',
                  wordBreak: 'break-all',
                }}
              >
                {job.id}
              </div>
            </div>

            <div>
              <div className="form-label">Status</div>
              <div>
                <span className={`badge badge-${job.status.toLowerCase()}`}>
                  <span className="badge-dot" />
                  {job.status}
                </span>
              </div>
            </div>

            <div>
              <div className="form-label">Created At</div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {new Date(job.createdAt).toLocaleString()}
              </div>
            </div>

            <div>
              <div className="form-label">Updated At</div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {new Date(job.updatedAt).toLocaleString()}
              </div>
            </div>

            {job.startedAt && (
              <div>
                <div className="form-label">Started At</div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  {new Date(job.startedAt).toLocaleString()}
                </div>
              </div>
            )}

            {job.completedAt && (
              <div>
                <div className="form-label">Completed At</div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  {new Date(job.completedAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {job.error && (
            <div className="alert alert-error" style={{ marginBottom: '1.5rem' }}>
              <div>
                <strong>Job Error:</strong> {job.error}
              </div>
            </div>
          )}

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              <span className="form-label" style={{ marginBottom: 0 }}>
                Job Payload (JSON)
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCopyJson}
                style={{ padding: '0.25rem 0.5rem' }}
              >
                {copied ? <Check size={12} color="#34d399" /> : <Copy size={12} />}
                <span>{copied ? 'Copied' : 'Copy JSON'}</span>
              </button>
            </div>
            <pre className="json-viewer">
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
        </div>

        <div className="modal-footer">
          {job.status === 'PENDING' && (
            <button
              className="btn btn-danger-outline"
              onClick={() => {
                onCancelJob(job);
                onClose();
              }}
            >
              <Ban size={15} />
              <span>Cancel Job</span>
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
