import { Outlet, NavLink } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
export default function MainLayout() {
  const logout = useAuthStore((state) => state.logout);
  const isSigningOut = useAuthStore((state) => state.isSigningOut);
  const logoutError = useAuthStore((state) => state.logoutError);
  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // logout() already destroyed the local session and recorded the failure in the store, which
      // this layout renders below; catching here only keeps the rejection from going unhandled.
    }
  };
  const navLinkClass = ({ isActive }: { isActive: boolean }) => `inline-flex items-center border-b-2 px-1 pt-1 text-sm font-medium ${isActive ? 'border-indigo-600 text-gray-900' : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2`;
  const mobileLinkClass = ({ isActive }: { isActive: boolean }) => `flex flex-col items-center rounded px-2 py-1 text-xs ${isActive ? 'font-semibold text-indigo-700' : 'text-gray-600 hover:text-gray-900'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600`;
  
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <span className="text-xl font-bold">AnyWear</span>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <NavLink
                  to="/dashboard"
                  end
                  className={navLinkClass}
                >
                  Dashboard
                </NavLink>
                <NavLink
                  to="/wardrobe"
                  className={navLinkClass}
                >
                  Wardrobe
                </NavLink>
                <NavLink
                  to="/mirror"
                  className={navLinkClass}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 mr-1">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  The Mirror
                </NavLink>
                <NavLink
                  to="/settings"
                  className={navLinkClass}
                >
                  Settings
                </NavLink>
              </div>
            </div>
            <div className="flex items-center">
              {logoutError ? (
                <p role="alert" className="max-w-xs text-right text-sm text-red-600">
                  Sign-out failed: {logoutError}. Your session was cleared on this device.
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => { void handleLogout(); }}
                disabled={isSigningOut}
                className="ml-3 inline-flex items-center rounded-lg border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSigningOut ? 'Signing out...' : 'Logout'}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* `pb-24` below `sm` keeps the last card scrollable clear of the fixed
          bottom navigation; the desktop breakpoint keeps the original `py-6`.
          The safe-area inset itself is consumed by the Android shell
          (MainActivity), not by CSS, so this is the only bottom clearance the
          page owns. */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-24 sm:px-6 sm:pb-6 lg:px-8">
        <Outlet />
      </main>
      
      {/* Mobile Bottom Navigation */}
      <nav aria-label="Mobile navigation" className="sm:hidden fixed bottom-0 w-full bg-white border-t border-gray-200">
        <div className="flex justify-around py-3">
          <NavLink to="/dashboard" end className={mobileLinkClass}>
            <span className="text-xs">Dashboard</span>
          </NavLink>
          <NavLink to="/wardrobe" className={mobileLinkClass}>
            <span className="text-xs">Wardrobe</span>
          </NavLink>
          <NavLink to="/mirror" className={mobileLinkClass}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <span className="text-xs">Mirror</span>
          </NavLink>
          <NavLink to="/settings" className={mobileLinkClass}>
            <span className="text-xs">Settings</span>
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
