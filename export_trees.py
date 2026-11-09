"""Export the trained XGBoost booster to a plain JS tree ensemble.

The Worker cannot run onnxruntime-web (no WASM runtime in the bundle), so the
same model is exported as compact arrays and walked in JavaScript. A node is
[featureIndex, threshold, yesChild, noChild]; a leaf is a number.

Usage: python export_trees.py
Reads models/model.ubj + models/feature_columns.json, writes
functions/api/model-trees.js.
"""
import json
import os

import xgboost as xgb

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(ROOT, 'models', 'model.ubj')
FEATURES_FILE = os.path.join(ROOT, 'models', 'feature_columns.json')
OUT = os.path.join(ROOT, 'functions', 'api', 'model-trees.js')


def convert(node, features):
    if 'leaf' in node:
        return round(node['leaf'], 6)
    feature_index = features.index(node['split'])
    yes = next(c for c in node['children'] if c['nodeid'] == node['yes'])
    no = next(c for c in node['children'] if c['nodeid'] == node['no'])
    return [feature_index, round(node['split_condition'], 6),
            convert(yes, features), convert(no, features)]


def main():
    with open(FEATURES_FILE, encoding='utf-8') as handle:
        features = json.load(handle)

    booster = xgb.Booster()
    booster.load_model(MODEL)
    dump = booster.get_dump(dump_format='json')
    trees = [convert(json.loads(tree), features) for tree in dump]

    learner = json.loads(booster.save_config())['learner']['learner_model_param']
    base_score = float(learner['base_score'].strip('[]'))

    lines = [
        '// Auto-generated from models/model.ubj (XGBoost). Do not edit by hand.',
        '// Regenerate with: python export_trees.py',
        'export const FEATURES = ' + json.dumps(features) + ';',
        'export const BASE_SCORE = ' + repr(base_score) + ';',
        'export const TREES = ' + json.dumps(trees, separators=(',', ':')) +
        '; // ' + str(len(trees)) + ' trees',
        '',
    ]
    with open(OUT, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(lines))

    print('wrote %s (%d trees, %d features, base %.6f)' %
          (OUT, len(trees), len(features), base_score))


if __name__ == '__main__':
    main()
