import { createColorScheme, createLocalStorage } from '@ui-sdk/core';

/**
 * Light, dark or the device's setting, saved in this browser and set on
 * `<html>` as `data-color-scheme`. The Vite config imports it too, for the
 * script that applies the choice before the app loads, so it stays free of React.
 */
export const colorScheme = createColorScheme({
  storage: createLocalStorage('platform-console:color-scheme'),
  global: true,
});
