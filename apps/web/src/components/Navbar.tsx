import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Layers, Plus, LogOut, LogIn } from 'lucide-react';

interface NavbarProps {
  onOpenNewJob: () => void;
  onOpenAuth: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenNewJob, onOpenAuth }) => {
  const { user, logout } = useAuth();

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <div className="brand">
          <div className="brand-icon">
            <Layers size={18} />
          </div>
          <span>ForgeFlow</span>
          <span className="badge badge-type" style={{ marginLeft: '0.25rem' }}>
            V1
          </span>
        </div>

        <div className="nav-actions">
          {user ? (
            <>
              <div className="user-pill" title={user.email}>
                <div className="user-avatar">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <span>{user.name}</span>
              </div>

              <button
                className="btn btn-primary"
                onClick={onOpenNewJob}
                id="btn-new-job"
              >
                <Plus size={16} />
                <span>Submit Job</span>
              </button>

              <button
                className="btn btn-secondary btn-sm"
                onClick={logout}
                title="Log out"
                id="btn-logout"
              >
                <LogOut size={16} />
                <span>Logout</span>
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              onClick={onOpenAuth}
              id="btn-signin"
            >
              <LogIn size={16} />
              <span>Sign In / Register</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
