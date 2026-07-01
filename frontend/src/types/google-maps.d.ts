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
    open(map: GMap, anchor?: GMarker): void;
    close(): void;
  }
  interface GoogleMapsNS {
    Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
    Polyline: new (opts: Record<string, unknown>) => GPolyline;
    Marker: new (opts: Record<string, unknown>) => GMarker;
    InfoWindow: new (opts?: Record<string, unknown>) => GInfoWindow;
    LatLngBounds: new () => GLatLngBounds;
    SymbolPath: { CIRCLE: number; BACKWARD_CLOSED_ARROW: number; FORWARD_CLOSED_ARROW: number };
  }
  interface Window {
    google?: { maps: GoogleMapsNS };
  }
}
