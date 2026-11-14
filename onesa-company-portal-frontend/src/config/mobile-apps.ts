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
export const mobileApps: readonly MobileApp[] = [
  {name: 'Onesa Mobile', website: 'https://mobile.onesa.eu/'},
  {name: 'PasoFi', parent: 'Onesa Mobile', website: 'https://pasofi.mobile.onesa.eu/'},
  {name: 'Diaspora Unlocked', website: 'https://www.diasporaunlocked.com/#mobile-apps-title'},
  {name: 'Smart Farmer'},
  {name: 'Onesa Drone', website: 'https://drone.onesa.eu/'},
];
