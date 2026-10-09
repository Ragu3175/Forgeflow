import React from 'react';
import { JobStatsSummary } from '@forgeflow/shared';
import { Layers, Clock, PlayCircle, CheckCircle2, XCircle, Ban } from 'lucide-react';

interface StatsOverviewProps {
  stats: JobStatsSummary;
  selectedStatus?: string;
  onSelectStatus?: (status: string | undefined) => void;
}

export const StatsOverview: React.FC<StatsOverviewProps> = ({
  stats,
  selectedStatus,
  onSelectStatus,
}) => {
  const statCards = [
    {
      title: 'Total Jobs',
      value: stats.total,
      key: undefined,
      icon: <Layers size={18} color="#818cf8" />,
      accent: 'rgba(99, 102, 241, 0.1)',
    },
    {
      title: 'Pending',
      value: stats.pending,
      key: 'PENDING',
      icon: <Clock size={18} color="#fbbf24" />,
      accent: 'var(--status-pending-bg)',
    },
    {
      title: 'Running',
      value: stats.running,
      key: 'RUNNING',
      icon: <PlayCircle size={18} color="#60a5fa" />,
      accent: 'var(--status-running-bg)',
    },
    {
      title: 'Completed',
      value: stats.completed,
      key: 'COMPLETED',
      icon: <CheckCircle2 size={18} color="#34d399" />,
      accent: 'var(--status-completed-bg)',
    },
    {
      title: 'Failed',
      value: stats.failed,
      key: 'FAILED',
      icon: <XCircle size={18} color="#f87171" />,
      accent: 'var(--status-failed-bg)',
    },
    {
      title: 'Cancelled',
      value: stats.cancelled,
      key: 'CANCELLED',
      icon: <Ban size={18} color="#9ca3af" />,
      accent: 'var(--status-cancelled-bg)',
    },
  ];

  return (
    <div className="stats-grid">
      {statCards.map((card) => {
        const isSelected = selectedStatus === card.key;
        return (
          <div
            key={card.title}
            className="stat-card"
            style={{
              cursor: onSelectStatus ? 'pointer' : 'default',
              borderColor: isSelected ? 'var(--brand-primary)' : undefined,
              boxShadow: isSelected ? '0 0 15px var(--brand-glow)' : undefined,
            }}
            onClick={() => onSelectStatus && onSelectStatus(isSelected ? undefined : card.key)}
            title={onSelectStatus ? `Filter by ${card.title}` : undefined}
          >
            <div className="stat-card-header">
              <span className="stat-title">{card.title}</span>
              <div
                className="stat-icon"
                style={{ backgroundColor: card.accent }}
              >
                {card.icon}
              </div>
            </div>
            <div className="stat-value">{card.value}</div>
          </div>
        );
      })}
    </div>
  );
};
