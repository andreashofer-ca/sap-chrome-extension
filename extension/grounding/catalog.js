// Fiori App Catalog — grounding data for navigation and context injection.
// Loaded as a plain script before sidepanel.js; assigns to window.FIORI_CATALOG.
//
// Each entry key is the Fiori intent string (SemanticObject-Action).
// navParams are the user-visible parameters from the app's Target Mapping.
// systemParams are always appended silently (sap-fiori-id, sap-tag, etc.).
//
// Source: Fiori Apps Library F0711, Implementation Information → Target Mappings
//   Semantic Object : Customer
//   Semantic Action : manageLineItems

'use strict';

window.FIORI_CATALOG = {

  'Customer-manageLineItems': {
    appId:  'F0711',
    title:  'Manage Customer Line Items',
    semanticObject: 'Customer',
    semanticAction: 'manageLineItems',
    role:   'Accounts Receivable Accountant',
    description:
      'Find and work with customer line items (AR). Supports open/cleared items, ' +
      'payment & dunning blocks, dispute cases. Key app for AR Factoring and ' +
      'Request-to-Pay workflows.',
    helpUrl:
      'https://help.sap.com/docs/SAP_S4HANA_CLOUD/918bca53037f408f91a2295d04ac16bc/' +
      '37E57E54279C2457E10000000A44176D.html',

    // Navigation parameters the user/LLM can supply to pre-filter the app.
    // Sourced directly from the Target Mapping parameter list.
    navParams: [
      {
        name:        'Customer',
        label:       'Customer',
        type:        'string',
        description: 'Customer account number (e.g. 10000, C-0001). ' +
                     'Defaults to the user\'s default customer when omitted.',
      },
      {
        name:        'CompanyCode',
        label:       'Company Code',
        type:        'string',
        description: 'Company code (e.g. 1010, US01). ' +
                     'Defaults to the user\'s default company code when omitted.',
      },
      {
        name:        'DueItemCategory',
        label:       'Due Item Category',
        type:        'enum',
        values:      [['1', 'Not yet due'], ['2', 'Due'], ['3', 'Overdue']],
        description: '1 = not yet due, 2 = due, 3 = overdue. Omit to see all.',
      },
      {
        name:        'IsCleared',
        label:       'Cleared Status',
        type:        'enum',
        values:      [['', 'Open items (default)'], ['X', 'Cleared items only']],
        description: 'Empty = open items only (default), X = show only cleared items.',
      },
      {
        name:        'PostingDate',
        label:       'Posting Date',
        type:        'date',
        description: 'Filter by posting date. Format: YYYY-MM-DD.',
      },
      {
        name:        'KeyDate',
        label:       'Key Date',
        type:        'date',
        description: 'Key date for open item selection. Format: YYYY-MM-DD.',
      },
      {
        name:        'ClearingDate',
        label:       'Clearing Date',
        type:        'date',
        description: 'Date the item was cleared. Format: YYYY-MM-DD.',
      },
    ],

    // Always included in navigation URLs; not shown in the parameter menu.
    systemParams: {
      'sap-fiori-id':  'F0711',
      'sap-tag':       'superiorAction',
      'sap-keep-alive': 'restricted',
    },
  },

};

/**
 * Build a Fiori intent navigation URL with pre-applied filter parameters.
 *
 * Format:
 *   https://<host>/ui?sap-language=en#<SemanticObject>-<Action>?<params>
 *
 * @param {string} host   - Tenant hostname, e.g. "your-tenant.s4hana.cloud.sap" (anonymized example)
 * @param {string} intent - Fiori intent key, e.g. "Customer-manageLineItems"
 * @param {Object} params - Optional user-supplied parameter key/value pairs
 * @returns {string} Full navigation URL ready to use as an href
 */
window.buildFioriUrl = function buildFioriUrl(host, intent, params) {
  const entry = window.FIORI_CATALOG[intent];
  const sysParams = entry ? entry.systemParams : {};
  const merged = Object.assign({}, sysParams, params || {});

  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');

  const base = 'https://' + host + '/ui?sap-language=en';
  return qs ? base + '#' + intent + '?' + qs : base + '#' + intent;
};
