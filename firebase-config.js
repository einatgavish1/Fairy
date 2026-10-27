// Firebase web config for project fairy-36dc8 (public by nature; access is enforced by firestore.rules).
// While apiKey is empty the app runs in local mode and keeps the records in this browser only.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "fairy-36dc8.firebaseapp.com",
  projectId: "fairy-36dc8",
  storageBucket: "fairy-36dc8.firebasestorage.app",
  messagingSenderId: "",
  appId: "",
};

// The owners can always sign in and manage who else may (the "שיתוף" button).
// Keep in step with isOwner() in firestore.rules.
export const OWNER_EMAILS = ["gavishori@gmail.com"];
