import React, { useState } from 'react';
import { JobType, JOB_TYPES, CreateJobDto } from '@forgeflow/shared';
import { X, Sparkles, Send, AlertCircle } from 'lucide-react';

interface NewJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitJob: (dto: CreateJobDto) => Promise<void>;
}

const TEMPLATES: Record<JobType, Record<string, any>> = {
  PDF_GENERATION: {
    templateId: 'invoice-standard-v1',
    documentTitle: 'Monthly Invoice #4092',
    recipient: 'client@example.com',
    items: [
      { description: 'Cloud Infrastructure Usage', hours: 160, rate: 75 },
      { description: 'Database Storage & Backup', gb: 500, rate: 0.1 }
    ],
    currency: 'USD'
  },
  DATA_PROCESSING: {
    datasetUrl: 'https://datasets.forgeflow.internal/q3-logs.csv',
    operation: 'AGGREGATE_METRICS',
    chunkSize: 5000,
    exportFormat: 'parquet'
  },
  AI_SUMMARY: {
    model: 'gemini-1.5-pro',
    documentId: 'doc-8941',
    prompt: 'Summarize key architecture trade-offs and action items.',
    maxTokens: 1000
  },
  EMAIL: {
    to: 'devops-team@company.com',
    subject: 'ForgeFlow System Status Update',
    template: 'system-alert-html',
    variables: {
      clusterHealth: 'OPTIMAL',
      pendingQueue: 0
    }
  },
  CUSTOM: {
    task: 'custom-user-script',
    parameters: {
      mode: 'synchronous-test',
      debug: true
    }
  }
};

export const NewJobModal: React.FC<NewJobModalProps> = ({
  isOpen,
  onClose,
  onSubmitJob,
}) => {
  const [type, setType] = useState<JobType>('PDF_GENERATION');
  const [payloadText, setPayloadText] = useState<string>(
    JSON.stringify(TEMPLATES['PDF_GENERATION'], null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleTypeChange = (newType: JobType) => {
    setType(newType);
    setPayloadText(JSON.stringify(TEMPLATES[newType], null, 2));
    setJsonError(null);
  };

  const handlePayloadChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPayloadText(val);
    try {
      if (val.trim()) {
        JSON.parse(val);
      }
      setJsonError(null);
    } catch (err: any) {
      setJsonError('Invalid JSON format: ' + err.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    let parsedPayload = {};
    if (payloadText.trim()) {
      try {
        parsedPayload = JSON.parse(payloadText);
      } catch (err: any) {
        setJsonError('Invalid JSON format: ' + err.message);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      await onSubmitJob({
        type,
        payload: parsedPayload,
      });
      onClose();
    } catch (err: any) {
      setServerError(err.message || 'Failed to create job');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content modal-content-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title">Submit New Job</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {serverError && (
              <div className="alert alert-error">
                <AlertCircle size={16} />
                <span>{serverError}</span>
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="job-type">
                Job Type
              </label>
              <select
                id="job-type"
                className="select"
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as JobType)}
              >
                {JOB_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span className="form-hint">
                In V1, creating a job records it with status <strong>PENDING</strong> in PostgreSQL.
              </span>
            </div>

            <div className="form-group">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <label className="form-label" htmlFor="job-payload">
                  Job Payload (JSON)
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                  onClick={() => {
                    setPayloadText(JSON.stringify(TEMPLATES[type], null, 2));
                    setJsonError(null);
                  }}
                >
                  <Sparkles size={12} color="#818cf8" />
                  <span>Reset to Template</span>
                </button>
              </div>

              <textarea
                id="job-payload"
                className="textarea font-mono"
                rows={8}
                value={payloadText}
                onChange={handlePayloadChange}
                placeholder="{}"
                style={{
                  fontSize: '0.8125rem',
                  borderColor: jsonError ? '#ef4444' : undefined,
                }}
              />
              {jsonError ? (
                <span style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {jsonError}
                </span>
              ) : (
                <span className="form-hint">
                  Valid JSON data object representing the parameters for this job type.
                </span>
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || !!jsonError}
              id="btn-submit-job"
            >
              <Send size={15} />
              <span>{isSubmitting ? 'Creating Job...' : 'Submit Job'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
