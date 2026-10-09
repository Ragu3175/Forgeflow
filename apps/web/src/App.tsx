import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from './context/AuthContext';
import { api } from './services/api';
import {
  Job,
  JobStatus,
  JobType,
  JobStatsSummary,
  CreateJobDto,
} from '@forgeflow/shared';
import { Navbar } from './components/Navbar';
import { StatsOverview } from './components/StatsOverview';
import { JobFilters } from './components/JobFilters';
import { JobTable } from './components/JobTable';
import { JobDetailModal } from './components/JobDetailModal';
import { NewJobModal } from './components/NewJobModal';
import { AuthModal } from './components/AuthModal';
import { ShieldCheck, Plus, AlertCircle, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  const { user, isLoading: isAuthLoading } = useAuth();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<JobStatsSummary>({
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });

  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [filterStatus, setFilterStatus] = useState<JobStatus | undefined>();
  const [filterType, setFilterType] = useState<JobType | undefined>();
  const [searchTerm, setSearchTerm] = useState('');

  // Modals state
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isNewJobModalOpen, setIsNewJobModalOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const fetchJobsAndStats = useCallback(async () => {
    if (!user) {
      setJobs([]);
      setStats({ total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 });
      return;
    }

    setIsLoadingJobs(true);
    setActionError(null);
    try {
      const res = await api.jobs.list({
        status: filterStatus,
        type: filterType,
      });
      setJobs(res.jobs);
      setStats(res.stats);
    } catch (err: any) {
      console.error('Failed to fetch jobs:', err);
      setActionError(err.message || 'Failed to load jobs');
    } finally {
      setIsLoadingJobs(false);
    }
  }, [user, filterStatus, filterType]);

  useEffect(() => {
    fetchJobsAndStats();
  }, [fetchJobsAndStats]);

  const handleCreateJob = async (dto: CreateJobDto) => {
    try {
      const created = await api.jobs.create(dto);
      setActionSuccess(`Job #${created.id.slice(0, 8)} created successfully.`);
      setTimeout(() => setActionSuccess(null), 4000);
      await fetchJobsAndStats();
    } catch (err: any) {
      throw err;
    }
  };

  const handleCancelJob = async (job: Job) => {
    try {
      await api.jobs.cancel(job.id);
      setActionSuccess(`Job #${job.id.slice(0, 8)} cancelled.`);
      setTimeout(() => setActionSuccess(null), 4000);
      await fetchJobsAndStats();
    } catch (err: any) {
      setActionError(err.message || 'Failed to cancel job');
      setTimeout(() => setActionError(null), 5000);
    }
  };

  const handleViewJob = (job: Job) => {
    setSelectedJob(job);
    setIsDetailModalOpen(true);
  };

  // Filter jobs by search term (client side search over ID or Type)
  const filteredJobs = jobs.filter((j) => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      j.id.toLowerCase().includes(s) ||
      j.type.toLowerCase().includes(s) ||
      JSON.stringify(j.payload).toLowerCase().includes(s)
    );
  });

  return (
    <div className="app-container">
      <Navbar
        onOpenNewJob={() => setIsNewJobModalOpen(true)}
        onOpenAuth={() => setIsAuthModalOpen(true)}
      />

      <main className="main-content">
        {/* Banner for Unauthenticated Users */}
        {!user && !isAuthLoading && (
          <div
            className="content-card"
            style={{
              padding: '3rem 2rem',
              textAlign: 'center',
              marginBottom: '2rem',
              background: 'linear-gradient(180deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.9) 100%)',
            }}
          >
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '16px',
                background: 'linear-gradient(135deg, #6366f1, #a855f7)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '1.25rem',
                boxShadow: '0 0 25px rgba(99, 102, 241, 0.4)',
              }}
            >
              <ShieldCheck size={28} color="#ffffff" />
            </div>
            <h2 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.5rem' }}>
              Welcome to ForgeFlow V1
            </h2>
            <p
              style={{
                color: 'var(--text-secondary)',
                maxWidth: '560px',
                margin: '0 auto 1.75rem auto',
                fontSize: '0.9375rem',
              }}
            >
              The foundational stage for our distributed job-processing engine. Sign in or
              create an account to submit, inspect, and manage asynchronous task records.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                onClick={() => setIsAuthModalOpen(true)}
              >
                Sign In or Register
              </button>
            </div>
          </div>
        )}

        {/* Action Alerts */}
        {actionSuccess && (
          <div className="alert alert-success">
            <Sparkles size={16} />
            <span>{actionSuccess}</span>
          </div>
        )}

        {actionError && (
          <div className="alert alert-error">
            <AlertCircle size={16} />
            <span>{actionError}</span>
          </div>
        )}

        {/* Dashboard Content for Authenticated Users */}
        {user && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '1.5rem',
                flexWrap: 'wrap',
                gap: '1rem',
              }}
            >
              <div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  Job Dashboard
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Overview of all queued and tracked task records for {user.name} ({user.email}).
                </p>
              </div>

              <button
                className="btn btn-primary"
                onClick={() => setIsNewJobModalOpen(true)}
              >
                <Plus size={16} />
                <span>New Job</span>
              </button>
            </div>

            {/* Metrics Grid */}
            <StatsOverview
              stats={stats}
              selectedStatus={filterStatus}
              onSelectStatus={(s) => setFilterStatus(s as JobStatus | undefined)}
            />

            {/* Jobs Table Card */}
            <div className="content-card">
              <JobFilters
                status={filterStatus}
                type={filterType}
                searchTerm={searchTerm}
                isLoading={isLoadingJobs}
                onStatusChange={setFilterStatus}
                onTypeChange={setFilterType}
                onSearchChange={setSearchTerm}
                onRefresh={fetchJobsAndStats}
              />

              <JobTable
                jobs={filteredJobs}
                isLoading={isLoadingJobs}
                onViewJob={handleViewJob}
                onCancelJob={handleCancelJob}
              />
            </div>
          </>
        )}
      </main>

      {/* Modals */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

      <NewJobModal
        isOpen={isNewJobModalOpen}
        onClose={() => setIsNewJobModalOpen(false)}
        onSubmitJob={handleCreateJob}
      />

      <JobDetailModal
        job={selectedJob}
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        onCancelJob={handleCancelJob}
      />
    </div>
  );
};
