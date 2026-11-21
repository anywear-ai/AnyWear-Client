import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { useClientVersionRefusalStore } from './store/clientVersionRefusalStore';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { Hub } from 'aws-amplify/utils';
import FullPageLoading from './components/FullPageLoading';
import UpdateRequiredScreen from './components/UpdateRequiredScreen';
import AuthGate from './components/AuthGate';
import AuthLayout from './layouts/AuthLayout';
import MainLayout from './layouts/MainLayout';

const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const WardrobePage = lazy(() => import('./pages/wardrobe/WardrobePage'));
const FittingRoomPage = lazy(() => import('./pages/fitting-room/FittingRoomPage'));
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'));

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
  // One selector: the latch flips once, from absent to present, and stays set
  // for the life of the document. Everything below the provider — the auth
  // listener, the gate, the router, every screen and every retry they own — is
  // replaced by the one screen rather than patched.
  const clientVersionRefused = useClientVersionRefusalStore((state) => state.refusal !== null);

  return (
    <QueryClientProvider client={queryClient}>
      {clientVersionRefused ? (
        <UpdateRequiredScreen />
      ) : (
        <>
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
                  {/* Issue 313 — the tab is the Fitting Room. The retired path
                      keeps working for an existing bookmark or history entry and
                      lands on the one surface that composes an outfit. */}
                  <Route path="/fitting-room" element={<FittingRoomPage />} />
                  <Route path="/mirror" element={<Navigate to="/fitting-room" replace />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
                </Routes>
              </Suspense>
            </Router>
          </AuthGate>
        </>
      )}
    </QueryClientProvider>
  );
}

export default App;
