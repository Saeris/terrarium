// The Cirrus worker as Terrarium runs it: the package's worker and its Durable Objects, unchanged.
export {
  // oxlint-disable-next-line import/no-default-export -- a Worker module's fetch handler is its default export.
  default,
  AccountDurableObject,
  SpaceDurableObject,
  SpaceIndexDurableObject
} from "@getcirrus/pds";
