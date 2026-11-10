const ROUTE_DESTINATIONS: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/wardrobe': 'wardrobe',
  '/mirror': 'the mirror',
  '/settings': 'settings',
  '/login': 'sign in',
  '/register': 'registration',
  '/verify': 'email verification',
};

/**
 * The destination a route-loading card names. The fallback text a user reads is
 * `Loading {destination}...`, so the mapping lives beside the card both layouts
 * render instead of being restated per layout.
 */
export function routeDestinationName(pathname: string): string {
  return ROUTE_DESTINATIONS[pathname] ?? 'page';
}
