'use strict';

const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const SCHEMA_DIR = path.join(__dirname, '..', 'docs', 'schemas', 'stage19');
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
const schemaCache = new Map();

function loadSchema(name) {
  if (schemaCache.has(name)) return schemaCache.get(name);
  const filePath = path.join(SCHEMA_DIR, name);
  const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  schemaCache.set(name, schema);
  return schema;
}

function validateAgainstSchema(doc, schemaName) {
  const schema = loadSchema(schemaName);
  const validate = ajv.compile(schema);
  const ok = validate(doc);
  return ok
    ? { ok: true }
    : { ok: false, errors: (validate.errors || []).map((e) => ({ keyword: e.keyword, instancePath: e.instancePath, message: e.message })) };
}

function validatePublishedBundleDocs(docs) {
  const errors = [];
  const mapping = {
    catalog: 'catalog_v0.json',
    crossPass: 'cross_pass_v0.json',
    heading: 'heading_v0.json',
    bev: 'bev_v0.json',
    exclusions: 'exclusions_v0.json',
    unassociated: 'unassociated_v0.json',
    promotion: 'promotion_v0.json',
    manifest: 'manifest_v0.json',
    commit: 'commit_v0.json',
  };
  for (const [key, schemaName] of Object.entries(mapping)) {
    if (!docs[key]) continue;
    const result = validateAgainstSchema(docs[key], schemaName);
    if (!result.ok) errors.push({ doc: key, schema: schemaName, errors: result.errors });
  }
  for (const a of docs.assessments || []) {
    const result = validateAgainstSchema(a, 'assessment_v0.json');
    if (!result.ok) errors.push({ doc: 'assessment', schema: 'assessment_v0.json', errors: result.errors });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = {
  validateAgainstSchema,
  validatePublishedBundleDocs,
  loadSchema,
};
