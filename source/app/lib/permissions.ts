import type {Profile} from './types';
export const privilegedRoles=['judge','reviewer','organiser','administrator'] as const;
export function hasRole(profile:Profile|null|undefined,role:string){return !!profile&&(profile.role===role||!!profile.roles?.includes(role));}
export function canOrganise(profile:Profile|null|undefined){return hasRole(profile,'organiser')||hasRole(profile,'administrator');}
export function canAdminister(profile:Profile|null|undefined){return hasRole(profile,'administrator');}
