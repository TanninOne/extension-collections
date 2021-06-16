export const MOD_TYPE = 'collection';
export const NAMESPACE = 'collection';
export const AUTHOR_UNKNOWN = '<Unknown User>';
export const AVATAR_FALLBACK = 'assets/images/noavatar.png';
export const NEXUS_DOMAIN = process.env['NEXUS_DOMAIN'] || 'nexusmods.com';
export const NEXUS_BASE_URL = process.env['NEXUS_BASE_URL'] || `https://www.${NEXUS_DOMAIN}.com`;
export const NEXUS_MEMBERSHIP_URL = `https://users.${NEXUS_DOMAIN}/register/memberships`;

export const TOS_URL = 'https://help.nexusmods.com/article/115-collections-terms-of-service';

export const BUNDLED_PATH = 'bundled';

export const INSTALLING_NOTIFICATION_ID = 'installing-collection-';

// limits
export const MIN_COLLECTION_NAME_LENGTH = 4;
export const MAX_COLLECTIION_NAME_LENGTH = 36;
