import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Hub } from 'aws-amplify/utils';
import FullPageLoading from './components/FullPageLoading';
import AuthGate from './components/AuthGate';
import AuthLayout from './layouts/AuthLayout';
import MainLayout from './layouts/MainLayout';
import { registerProfileQueryPolicy } from './lib/profileQueryPolicy';

const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const WardrobePage = lazy(() => import('./pages/wardrobe/WardrobePage'));
const MirrorPage = lazy(() => import('./pages/mirror/MirrorPage'));
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));

const queryClient = new QueryClient();
// Every `useGetUsersMe` consumer inherits the one retry policy registered here.
registerProfileQueryPolicy(queryClient);

/**
 * The authentication decision only. The profile read no longer gates the shell:
 * `ProfileSyncStatus` inside `MainLayout` owns its pending and failed states, and
 * the routed page renders beside them. A 401 is still terminal: the Axios
 * interceptor clears the session and sends the browser to `/login`.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// Global listener for Amplify Hub authentication events
export function AuthListener() {
  const clearLocalAuth = useAuthStore((state) => state.clearLocalAuth);

  useEffect(() => {
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') {
        clearLocalAuth();
      }
    });

    return () => unsubscribe();
  }, [clearLocalAuth]);

  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthListener />
      <AuthGate>
        <Router>
          <Suspense fallback={<FullPageLoading />}>
            <Routes>
            {/* Auth Routes */}
            <Route element={<AuthLayout />}>
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/verify" element={<VerifyEmailPage />} />
              <Route path="/login" element={<LoginPage />} />
            </Route>

            {/* Protected Routes */}
            <Route
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/wardrobe" element={<WardrobePage />} />
              <Route path="/mirror" element={<MirrorPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            </Routes>
          </Suspense>
        </Router>
      </AuthGate>
    </QueryClientProvider>
  );
}

export default App;
