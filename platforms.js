/**
 * Field definitions for ~/.coa/config, transcribed from `coa describe config`
 * (CLI 7.41). Pure data + helpers, no `vscode` import.
 */

/** Coalesce SaaS access. Present on every profile, independent of the platform. */
const CLOUD_FIELDS = [
  {
    key: 'domain',
    label: 'Coalesce domain',
    placeholder: 'https://app.coalescesoftware.io',
    help: 'Your Coalesce tenant. Leave empty for the default.',
  },
  {
    key: 'token',
    label: 'Coalesce API key',
    secret: true,
    help: 'Refresh token. Required for cloud commands (plan, deploy, refresh) and for `coa serve`.',
  },
  {
    key: 'environmentID',
    label: 'Environment ID',
    placeholder: '12',
    help: 'Required for plan / deploy.',
  },
];

const SNOWFLAKE_COMMON = [
  { key: 'snowflakeAccount', label: 'Account identifier', required: true, placeholder: 'fka56740' },
  { key: 'snowflakeUsername', label: 'Username', required: true },
  { key: 'snowflakeWarehouse', label: 'Warehouse', placeholder: 'COMPUTE_WH' },
  { key: 'snowflakeRole', label: 'Role', placeholder: 'SYSADMIN' },
];

const DATABRICKS_COMMON = [
  { key: 'databricksHost', label: 'Host URL', required: true, placeholder: 'https://dbc-xxxxxxxx.cloud.databricks.com' },
  { key: 'databricksPath', label: 'SQL warehouse path', required: true, placeholder: '/sql/1.0/warehouses/xxxxxxxx' },
];

/** platformKind -> auth types -> fields. Order here is the order in the form. */
const PLATFORMS = {
  Snowflake: {
    label: 'Snowflake',
    authKey: 'snowflakeAuthType',
    auths: {
      Basic: {
        label: 'Username / password',
        fields: [...SNOWFLAKE_COMMON, { key: 'snowflakePassword', label: 'Password', secret: true, required: true }],
      },
      KeyPair: {
        label: 'Key pair',
        fields: [
          ...SNOWFLAKE_COMMON,
          {
            key: 'snowflakeKeyPairKey',
            label: 'Private key',
            secret: true,
            required: true,
            placeholder: '~/.coa/rsa_key.p8',
            help: 'Path to a .p8 file, or the PEM body itself.',
          },
          { key: 'snowflakeKeyPairPass', label: 'Key passphrase', secret: true },
        ],
      },
    },
  },
  Databricks: {
    label: 'Databricks',
    authKey: 'databricksAuthType',
    auths: {
      Token: {
        label: 'Personal access token',
        fields: [...DATABRICKS_COMMON, { key: 'databricksToken', label: 'Access token', secret: true, required: true }],
      },
      OAuthM2M: {
        label: 'OAuth machine-to-machine',
        fields: [
          ...DATABRICKS_COMMON,
          { key: 'databricksClientID', label: 'Client ID', required: true },
          { key: 'databricksClientSecret', label: 'Client secret', secret: true, required: true },
        ],
      },
    },
  },
  BigQuery: {
    label: 'BigQuery',
    authKey: 'bigQueryAuthType',
    auths: {
      ServiceAccount: {
        label: 'Service account',
        fields: [
          {
            key: 'bigQueryServiceAccountKey',
            label: 'Service account key',
            secret: true,
            required: true,
            placeholder: '/path/to/key.json',
            help: 'Path to the service account JSON key file.',
          },
        ],
      },
    },
  },
};

const PLATFORM_NAMES = Object.keys(PLATFORMS);

/** Every key any platform can own — used to clear stale keys when the platform changes. */
const ALL_PLATFORM_KEYS = (() => {
  const keys = new Set(['platformKind']);
  for (const platform of Object.values(PLATFORMS)) {
    keys.add(platform.authKey);
    for (const auth of Object.values(platform.auths)) for (const f of auth.fields) keys.add(f.key);
  }
  return keys;
})();

const SECRET_KEYS = (() => {
  const keys = new Set(CLOUD_FIELDS.filter((f) => f.secret).map((f) => f.key));
  for (const platform of Object.values(PLATFORMS)) {
    for (const auth of Object.values(platform.auths)) {
      for (const f of auth.fields) if (f.secret) keys.add(f.key);
    }
  }
  return keys;
})();

function authTypesFor(platformKind) {
  return Object.keys(PLATFORMS[platformKind]?.auths || {});
}

function fieldsFor(platformKind, authType) {
  const platform = PLATFORMS[platformKind];
  if (!platform) return [];
  const auth = platform.auths[authType] || platform.auths[authTypesFor(platformKind)[0]];
  return auth ? auth.fields : [];
}

/**
 * `platformKind` is absent on Snowflake profiles written by older CLIs, so fall
 * back to sniffing which platform's keys are present.
 */
function platformKindOf(entries = {}) {
  if (entries.platformKind && PLATFORMS[entries.platformKind]) return entries.platformKind;
  for (const name of PLATFORM_NAMES) {
    const prefix = name.charAt(0).toLowerCase() + name.slice(1); // snowflake / databricks / bigQuery
    if (Object.keys(entries).some((k) => k.startsWith(prefix))) return name;
  }
  return 'Snowflake';
}

function authTypeOf(entries = {}, platformKind = platformKindOf(entries)) {
  const platform = PLATFORMS[platformKind];
  if (!platform) return undefined;
  const value = entries[platform.authKey];
  return value && platform.auths[value] ? value : authTypesFor(platformKind)[0];
}

module.exports = {
  CLOUD_FIELDS,
  PLATFORMS,
  PLATFORM_NAMES,
  ALL_PLATFORM_KEYS,
  SECRET_KEYS,
  authTypesFor,
  fieldsFor,
  platformKindOf,
  authTypeOf,
};
