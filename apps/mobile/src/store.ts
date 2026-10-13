/**
 * Small values the app keeps between launches: the sign-in, the server
 * address, the theme. On a phone this is the system's secure store. In a
 * browser (store.web.ts) it is the page's local storage, where the sign-in
 * itself is not kept at all: the browser holds that as a cookie.
 */
export { deleteItemAsync, getItem, getItemAsync, setItem, setItemAsync } from "expo-secure-store";
