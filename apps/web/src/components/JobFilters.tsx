import React from 'react';
import { JobStatus, JobType, JOB_STATUSES, JOB_TYPES } from '@forgeflow/shared';
import { Search, RefreshCw } from 'lucide-react';

interface JobFiltersProps {
  status?: JobStatus;
  type?: JobType;
  searchTerm: string;
  isLoading: boolean;
  onStatusChange: (status?: JobStatus) => void;
  onTypeChange: (type?: JobType) => void;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
}

export const JobFilters: React.FC<JobFiltersProps> = ({
  status,
  type,
  searchTerm,
  isLoading,
  onStatusChange,
  onTypeChange,
  onSearchChange,
  onRefresh,
}) => {
  return (
    <div className="card-toolbar">
      <div className="filter-group">
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <input
            type="text"
            className="input"
            placeholder="Search by ID or type..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ paddingLeft: '2rem', width: '220px' }}
          />
          <Search
            size={14}
            color="#6b7280"
            style={{
              position: 'absolute',
              left: '0.625rem',
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          />
        </div>

        <select
          className="select"
          value={status || ''}
          onChange={(e) => onStatusChange(e.target.value ? (e.target.value as JobStatus) : undefined)}
          id="filter-status"
        >
          <option value="">All Statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          className="select"
          value={type || ''}
          onChange={(e) => onTypeChange(e.target.value ? (e.target.value as JobType) : undefined)}
          id="filter-type"
        >
          <option value="">All Job Types</option>
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <button
        className="btn btn-secondary btn-sm"
        onClick={onRefresh}
        disabled={isLoading}
        title="Refresh jobs list"
        id="btn-refresh"
      >
        <RefreshCw size={14} className={isLoading ? 'spin' : ''} />
        <span>Refresh</span>
      </button>
    </div>
  );
};
