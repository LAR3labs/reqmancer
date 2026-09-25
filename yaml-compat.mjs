import * as yaml from 'js-yaml';

export * from 'js-yaml';

export function load(input, options) {
  const documents = yaml.loadAll(input, options);
  if (documents.length > 1) {
    throw new yaml.YAMLException('expected a single document in the stream');
  }
  return documents[0];
}
