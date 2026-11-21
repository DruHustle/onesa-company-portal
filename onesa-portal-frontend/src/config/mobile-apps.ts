type IosDownload = {channel: 'App Store' | 'TestFlight'; url: `https://${string}`};
type AndroidDownload = {channel: 'Google Play' | 'APK'; url: `https://${string}`};

export type MobileApp = {
  name: string;
  website?: string;
  parent?: string;
  ios?: IosDownload;
  android?: AndroidDownload;
};

// Add a platform destination after verifying the published listing, public
// TestFlight invite, or the versioned APK signed with the product's release key.
// List every product even before native store submission. A missing verified
// store destination must remain a non-clickable "Not yet available" badge.
export const mobileApps: readonly MobileApp[] = [
  {name: 'Onesa AI Platform', website: 'https://platform.onesa.eu/'},
  {name: 'Onesa Robot', website: 'https://robot.onesa.eu/'},
  {name: 'Onesa Drone', website: 'https://drone.onesa.eu/'},
  {name: 'Smart Farmer'},
  {name: 'Smart Logistics', website: 'https://logistics.onesa.eu/'},
  {name: 'Smart Factory', website: 'https://factory.onesa.eu/'},
  {name: 'Onesa Mobile', website: 'https://mobile.onesa.eu/'},
  {name: 'PasoFi', parent: 'Onesa Mobile', website: 'https://pasofi.mobile.onesa.eu/'},
];
