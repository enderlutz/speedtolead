// Minimal ambient typings for the small slice of the Google Maps JS API the
// estimator drive-path map uses. Avoids pulling in the full @types/google.maps
// dependency while keeping us off `any`.
export {};

declare global {
  interface GLatLngLiteral {
    lat: number;
    lng: number;
  }
  interface GMap {
    fitBounds(bounds: GLatLngBounds): void;
    setCenter(p: GLatLngLiteral): void;
    setZoom(z: number): void;
    getCenter(): GLatLng | undefined;
    getZoom(): number | undefined;
  }
  interface GLatLngBounds {
    extend(p: GLatLngLiteral): void;
    isEmpty(): boolean;
  }
  interface GPolyline {
    setMap(map: GMap | null): void;
  }
  interface GMarker {
    setMap(map: GMap | null): void;
    addListener(event: string, handler: () => void): void;
    getPosition(): GLatLngLiteral | undefined;
  }
  interface GInfoWindow {
    setContent(content: string): void;
    setPosition(p: GLatLngLiteral): void;
    open(map: GMap, anchor?: GMarker): void;
    close(): void;
  }
  /** A live LatLng instance (what getCenter / geocoder results hand back),
   *  as opposed to the plain {lat, lng} literal we pass in. */
  interface GLatLng {
    lat(): number;
    lng(): number;
  }
  interface GGeocoderResult {
    geometry: { location: GLatLng };
    formatted_address?: string;
  }
  interface GGeocodeRequest {
    address: string;
    /** Narrows the search — country/state keep a wrong ZIP from resolving
     *  to an identically-named street in another state. */
    componentRestrictions?: {
      country?: string;
      administrativeArea?: string;
      postalCode?: string;
      locality?: string;
    };
  }
  interface GGeocoder {
    geocode(
      req: GGeocodeRequest,
      cb: (results: GGeocoderResult[] | null, status: string) => void,
    ): void;
  }
  interface GoogleMapsNS {
    Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
    Polyline: new (opts: Record<string, unknown>) => GPolyline;
    Marker: new (opts: Record<string, unknown>) => GMarker;
    InfoWindow: new (opts?: Record<string, unknown>) => GInfoWindow;
    LatLngBounds: new () => GLatLngBounds;
    Geocoder: new () => GGeocoder;
    SymbolPath: { CIRCLE: number; BACKWARD_CLOSED_ARROW: number; FORWARD_CLOSED_ARROW: number };
    /** Needed to tell a map its container changed size. Without it Google
     *  keeps hit-testing clicks against the old dimensions, so taps land
     *  nowhere near the finger. */
    event: { trigger(instance: unknown, eventName: string): void };
  }
  interface Window {
    google?: { maps: GoogleMapsNS };
    /** Called by Google when it rejects the Maps key (wrong referrer, API
     *  not enabled, billing off). The only programmatic signal — everything
     *  else goes to the console. Assigned in lib/googleMaps.ts. */
    gm_authFailure?: () => void;
  }
}
