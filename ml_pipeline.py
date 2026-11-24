#!/usr/bin/env python3
"""Consolidated ML helpers for the visa-timeline predictor.

Usage:
    python ml_pipeline.py generate   # regenerate data/training_data.json
    python ml_pipeline.py train      # train models/ and write metrics
    python ml_pipeline.py export     # write functions/api/model-trees.js
    python ml_pipeline.py all        # generate, train, then export

The monthly workflow runs `train` and `export`; `generate` is a manual step
because data/training_data.json is committed.
"""

from __future__ import annotations

import argparse
import json
import random
import warnings
from datetime import datetime, timedelta
from pathlib import Path

warnings.filterwarnings('ignore')

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / 'data'
MODEL_DIR = ROOT / 'models'
TRAINING_FILE = DATA_DIR / 'training_data.json'
MODEL_FILE = MODEL_DIR / 'model.ubj'
FEATURES_FILE = MODEL_DIR / 'feature_columns.json'
TREES_OUT = ROOT / 'functions' / 'api' / 'model-trees.js'

# Training dependencies are optional for `generate` and `export`; importing
# them lazily inside the training path keeps the synthetic-data generator
# usable with only the standard library.
try:
    import numpy as np
    import pandas as pd
    import xgboost as xgb
    from sklearn.metrics import (
        mean_absolute_error,
        mean_absolute_percentage_error,
        mean_squared_error,
    )
    from sklearn.model_selection import TimeSeriesSplit, train_test_split
except ImportError:
    np = None
    pd = None
    xgb = None
    mean_absolute_error = None
    mean_absolute_percentage_error = None
    mean_squared_error = None
    TimeSeriesSplit = None
    train_test_split = None


# ---------------------------------------------------------------------------
# Synthetic training data
# ---------------------------------------------------------------------------

EMBASSIES = [
    {"slug": "new-delhi", "name": "New Delhi", "daily_volume": 150, "base_days": 45, "country": "India"},
    {"slug": "beijing", "name": "Beijing", "daily_volume": 50, "base_days": 35, "country": "China"},
    {"slug": "dublin", "name": "Dublin", "daily_volume": 10, "base_days": 20, "country": "Ireland"},
    {"slug": "abu-dhabi", "name": "Abu Dhabi", "daily_volume": 8, "base_days": 25, "country": "UAE"},
    {"slug": "abuja", "name": "Abuja", "daily_volume": 3, "base_days": 40, "country": "Nigeria"},
    {"slug": "ankara", "name": "Ankara", "daily_volume": 0, "base_days": 30, "country": "Turkey"},
]

VISA_TYPES = ["study", "work", "visit", "family", "transit", "research"]

APPROVAL_RATES = {
    "study": 0.85,
    "work": 0.75,
    "visit": 0.70,
    "family": 0.80,
    "transit": 0.90,
    "research": 0.78,
}

EMBASSY_APPROVAL = {
    "new-delhi": 0.78,
    "beijing": 0.72,
    "dublin": 0.85,
    "abu-dhabi": 0.80,
    "abuja": 0.65,
    "ankara": 0.75,
}


def generate_application_number(base_year=2020):
    """Generate realistic application numbers like IRL123456."""
    year = random.randint(2020, 2026)
    seq = random.randint(100000, 999999)
    return f"IRL{year}{seq}"


def generate_decision_date(application_date_str, visa_type, embassy_slug):
    """Generate a realistic decision date based on visa type and embassy."""
    app_date = datetime.strptime(application_date_str, "%Y-%m-%d")
    embassy = next(e for e in EMBASSIES if e["slug"] == embassy_slug)
    base_days = embassy["base_days"]

    visa_adjustments = {
        "study": 5,
        "work": -2,
        "visit": -10,
        "family": 5,
        "transit": -25,
        "research": 3,
    }
    base_days += visa_adjustments.get(visa_type, 0)

    month = app_date.month
    if month in [5, 6, 7, 8, 12]:
        base_days += 7
    if month in [12, 1]:
        base_days += 5
    if app_date.weekday() >= 5:
        base_days += 2

    base_days += random.randint(-5, 10)
    base_days = max(5, min(180, base_days))
    decision_date = app_date + timedelta(days=base_days)
    return decision_date.strftime("%Y-%m-%d")


def generate_synthetic_data(num_records=50000):
    """Generate synthetic visa decision data."""
    records = []
    total_volume = sum(e["daily_volume"] for e in EMBASSIES)

    for embassy in EMBASSIES:
        if embassy["daily_volume"] == 0:
            continue

        embassy_share = embassy["daily_volume"] / total_volume
        embassy_records = int(num_records * embassy_share)
        start_date = datetime(2023, 1, 1)
        end_date = datetime(2026, 1, 1)
        total_days = (end_date - start_date).days

        for _ in range(embassy_records):
            app_day = random.randint(0, total_days)
            app_date = start_date + timedelta(days=app_day)
            app_date_str = app_date.strftime("%Y-%m-%d")
            if app_date.weekday() >= 5:
                continue

            visa_type = random.choices(
                VISA_TYPES,
                weights=[0.25, 0.20, 0.30, 0.15, 0.05, 0.05],
            )[0]
            approval_rate = APPROVAL_RATES[visa_type] * EMBASSY_APPROVAL[embassy["slug"]]
            decision = "Granted" if random.random() < approval_rate else "Refused"
            decision_date_str = generate_decision_date(
                app_date_str, visa_type, embassy["slug"]
            )

            records.append({
                "date": decision_date_str,
                "number": generate_application_number(),
                "decision": decision,
                "visa_type": visa_type,
                "embassy": embassy["slug"],
                "application_date": app_date_str,
                "country": embassy["country"],
            })

    records.sort(key=lambda x: x["date"], reverse=True)
    return records


def run_generate():
    print("Generating synthetic training data...")
    records = generate_synthetic_data(50000)
    print(f"Generated {len(records)} records")

    DATA_DIR.mkdir(exist_ok=True)
    with open(TRAINING_FILE, "w") as handle:
        json.dump({"decisions": records}, handle, indent=2)
    print(f"Saved to {TRAINING_FILE}")

    by_embassy = {}
    by_visa = {}
    by_decision = {}
    for record in records:
        by_embassy[record["embassy"]] = by_embassy.get(record["embassy"], 0) + 1
        by_visa[record["visa_type"]] = by_visa.get(record["visa_type"], 0) + 1
        by_decision[record["decision"]] = by_decision.get(record["decision"], 0) + 1

    print("\nBy Embassy:")
    for key, value in sorted(by_embassy.items()):
        print(f"  {key}: {value}")
    print("\nBy Visa Type:")
    for key, value in sorted(by_visa.items()):
        print(f"  {key}: {value}")
    print("\nBy Decision:")
    for key, value in sorted(by_decision.items()):
        print(f"  {key}: {value}")
    return 0


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def load_training_data():
    """Load decisions from the generated training data."""
    if not TRAINING_FILE.exists():
        print(f"File not found: {TRAINING_FILE}")
        return None

    with open(TRAINING_FILE, "r") as handle:
        data = json.load(handle)
    df = pd.DataFrame(data["decisions"])
    print(f"Loaded {len(df)} records from training data")
    return df


def engineer_features(df):
    """Create features for the ML model."""
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    df["application_date"] = pd.to_datetime(df["application_date"])
    df["days_to_decision"] = (df["date"] - df["application_date"]).dt.days
    df = df[(df["days_to_decision"] >= 0) & (df["days_to_decision"] <= 365)]
    df["decision_encoded"] = df["decision"].map({"Granted": 1, "Refused": 0})

    df["year"] = df["application_date"].dt.year
    df["month"] = df["application_date"].dt.month
    df["day_of_week"] = df["application_date"].dt.dayofweek
    df["day_of_month"] = df["application_date"].dt.day
    df["week_of_year"] = df["application_date"].dt.isocalendar().week
    df["quarter"] = df["application_date"].dt.quarter
    df["is_weekend"] = df["day_of_week"].isin([5, 6]).astype(int)

    embassy_dummies = pd.get_dummies(df["embassy"], prefix="embassy")
    df = pd.concat([df, embassy_dummies], axis=1)
    if "visa_type" in df.columns:
        visa_dummies = pd.get_dummies(df["visa_type"], prefix="visa_type")
        df = pd.concat([df, visa_dummies], axis=1)

    def extract_app_num(number):
        try:
            return int("".join(filter(str.isdigit, str(number)))[-6:])
        except Exception:
            return 0

    df["app_num"] = df["number"].apply(extract_app_num)
    df["app_num_mod_100"] = df["app_num"] % 100
    df["app_num_mod_1000"] = df["app_num"] % 1000
    df["app_num_bucket"] = (df["app_num"] // 100000) * 100000

    df["is_peak_season"] = df["month"].isin([5, 6, 7, 8, 12]).astype(int)
    df["is_holiday_period"] = df["month"].isin([12, 1]).astype(int)

    df = df.sort_values(["embassy", "date"])
    for window in [7, 14, 30]:
        df[f"embassy_{window}d_approval_rate"] = df.groupby("embassy")["decision_encoded"].transform(
            lambda x: x.rolling(window, min_periods=1).mean()
        )
        df[f"embassy_{window}d_volume"] = df.groupby("embassy")["decision_encoded"].transform(
            lambda x: x.rolling(window, min_periods=1).count()
        )
    for window in [7, 14, 30]:
        df[f"global_{window}d_approval_rate"] = df["decision_encoded"].rolling(
            window, min_periods=1
        ).mean()
        df[f"global_{window}d_volume"] = df["decision_encoded"].rolling(
            window, min_periods=1
        ).count()

    base_times = {
        "new-delhi": 45,
        "beijing": 35,
        "dublin": 20,
        "abu-dhabi": 25,
        "abuja": 40,
        "ankara": 30,
    }
    df["embassy_base_days"] = df["embassy"].map(base_times).fillna(30)

    visa_adjustments = {
        "study": 5,
        "work": -2,
        "visit": -10,
        "family": 5,
        "transit": -25,
        "research": 3,
    }
    df["visa_adjustment"] = df["visa_type"].map(visa_adjustments).fillna(0)
    return df.dropna()


def prepare_features(df):
    """Prepare features and target for training."""
    y = df["days_to_decision"]
    exclude_cols = [
        "date",
        "application_date",
        "decision",
        "number",
        "embassy",
        "visa_type",
        "country",
        "days_to_decision",
        "decision_encoded",
        "visa_type_unknown",
        "embassy_unknown",
    ]
    feature_cols = [
        column
        for column in df.columns
        if column not in exclude_cols
        and df[column].dtype in ["int64", "float64", "int32", "float32", "uint8"]
    ]
    return df[feature_cols], y, feature_cols


def train_model(X_train, y_train, X_val, y_val):
    """Train the XGBoost model."""
    params = {
        "objective": "reg:squarederror",
        "eval_metric": ["mae", "rmse"],
        "max_depth": 6,
        "learning_rate": 0.1,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "n_estimators": 500,
        "early_stopping_rounds": 50,
        "random_state": 42,
        "verbosity": 1,
    }
    model = xgb.XGBRegressor(**params)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=50)
    return model


def evaluate_model(model, X_test, y_test):
    """Evaluate model performance."""
    preds = model.predict(X_test)
    return {
        "mae": float(mean_absolute_error(y_test, preds)),
        "rmse": float(np.sqrt(mean_squared_error(y_test, preds))),
        "mape": float(mean_absolute_percentage_error(y_test, preds)),
        "predictions": preds.tolist(),
    }


def export_onnx(model, feature_cols, output_path):
    """Export the model to ONNX, with the native XGBoost format as fallback."""
    try:
        from xgboost import XGBRegressor  # noqa: F401

        model.get_booster().save_model(str(output_path).replace(".onnx", ".ubj"))
        try:
            from skl2onnx import convert_sklearn, update_registered_converter
            from skl2onnx._convert import convert_xgboost
            from skl2onnx.common.data_types import FloatTensorType

            update_registered_converter(
                XGBRegressor,
                "XGBRegressor",
                lambda *args: None,
                convert_xgboost,
                options={"nocl": [True, False], "zipmap": [True, False, "columns"]},
            )
            initial_type = [("float_input", FloatTensorType([None, len(feature_cols)]))]
            onnx_model = convert_sklearn(model, initial_types=initial_type, target_opset=12)
            with open(output_path, "wb") as handle:
                handle.write(onnx_model.SerializeToString())
            print(f"Model exported to {output_path}")
            return True
        except Exception as error:
            print(f"ONNX export via skl2onnx failed: {error}")
            print("Using native XGBoost format instead")
            return False
    except ImportError as error:
        print(f"ONNX export skipped: {error}")
        return False


def save_model_artifacts(model, feature_cols, metrics, output_dir):
    """Save the model, feature list, metrics and API metadata."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(output_dir / "feature_columns.json", "w") as handle:
        json.dump(feature_cols, handle)
    with open(output_dir / "metrics.json", "w") as handle:
        json.dump(metrics, handle, indent=2)

    import pickle

    with open(output_dir / "model.pkl", "wb") as handle:
        pickle.dump(model, handle)

    export_onnx(model, feature_cols, output_dir / "model.onnx")

    model_info = {
        "version": "1.0.0",
        "features": feature_cols,
        "target": "days_to_decision",
        "model_type": "xgboost",
        "metrics": metrics,
    }
    with open(output_dir / "model_info.json", "w") as handle:
        json.dump(model_info, handle, indent=2)


def run_train():
    if pd is None or np is None or xgb is None or TimeSeriesSplit is None:
        print("ML dependencies missing. Install pandas, numpy, xgboost and scikit-learn.")
        return 1

    print("Loading training data...")
    df = load_training_data()
    if df is None:
        print("No training data found. Run `python ml_pipeline.py generate` first.")
        return 1

    print("Engineering features...")
    df = engineer_features(df)
    print("Preparing features...")
    X, y, feature_cols = prepare_features(df)
    print(f"Features: {len(feature_cols)}, Samples: {len(X)}")
    print(f"Feature columns: {feature_cols}")
    print(f"Target stats: mean={y.mean():.1f}, std={y.std():.1f}, min={y.min()}, max={y.max()}")

    splits = list(TimeSeriesSplit(n_splits=5).split(X))
    train_idx, test_idx = splits[-1]
    X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
    y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]
    X_train, X_val, y_train, y_val = train_test_split(
        X_train, y_train, test_size=0.2, shuffle=False
    )
    print(f"Train: {len(X_train)}, Val: {len(X_val)}, Test: {len(X_test)}")

    print("Training model...")
    model = train_model(X_train, y_train, X_val, y_val)
    print("Evaluating...")
    metrics = evaluate_model(model, X_test, y_test)
    print(f"MAE: {metrics['mae']:.2f} days")
    print(f"RMSE: {metrics['rmse']:.2f} days")
    print(f"MAPE: {metrics['mape']:.2%}")

    importance = pd.DataFrame({
        "feature": feature_cols,
        "importance": model.feature_importances_,
    }).sort_values("importance", ascending=False)
    print("\nTop 20 Features:")
    print(importance.head(20).to_string(index=False))

    print("\nSaving model artifacts...")
    save_model_artifacts(model, feature_cols, metrics, MODEL_DIR)

    predictions = model.predict(X_test)
    results = pd.DataFrame({
        "actual": y_test,
        "predicted": predictions,
        "error": np.abs(y_test - predictions),
    })
    results.to_csv(MODEL_DIR / "predictions.csv", index=False)
    print("Training complete!")
    return 0


# ---------------------------------------------------------------------------
# Tree export for the Worker
# ---------------------------------------------------------------------------

def convert(node, features):
    """Convert an XGBoost JSON node to the compact Worker representation."""
    if "leaf" in node:
        return round(node["leaf"], 6)
    feature_index = features.index(node["split"])
    yes = next(child for child in node["children"] if child["nodeid"] == node["yes"])
    no = next(child for child in node["children"] if child["nodeid"] == node["no"])
    return [
        feature_index,
        round(node["split_condition"], 6),
        convert(yes, features),
        convert(no, features),
    ]


def run_export():
    if xgb is None:
        print("xgboost is required for export. Install the ML dependencies.")
        return 1
    if not FEATURES_FILE.exists() or not MODEL_FILE.exists():
        print(f"Missing {FEATURES_FILE} or {MODEL_FILE}; run `python ml_pipeline.py train` first.")
        return 1

    with open(FEATURES_FILE, encoding="utf-8") as handle:
        features = json.load(handle)

    booster = xgb.Booster()
    booster.load_model(str(MODEL_FILE))
    dump = booster.get_dump(dump_format="json")
    trees = [convert(json.loads(tree), features) for tree in dump]

    learner = json.loads(booster.save_config())["learner"]["learner_model_param"]
    base_score = float(learner["base_score"].strip("[]"))

    lines = [
        "// Auto-generated from models/model.ubj (XGBoost). Do not edit by hand.",
        "// Regenerate with: python ml_pipeline.py export",
        "export const FEATURES = " + json.dumps(features) + ";",
        "export const BASE_SCORE = " + repr(base_score) + ";",
        "export const TREES = " + json.dumps(trees, separators=(",", ":")) +
        "; // " + str(len(trees)) + " trees",
        "",
    ]
    TREES_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(TREES_OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))

    print("wrote %s (%d trees, %d features, base %.6f)" % (
        TREES_OUT, len(trees), len(features), base_score
    ))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Visa-tracker ML pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("generate", help="regenerate data/training_data.json")
    subparsers.add_parser("train", help="train the model into models/")
    subparsers.add_parser("export", help="write functions/api/model-trees.js")
    subparsers.add_parser("all", help="generate, train, then export")

    args = parser.parse_args()
    if args.command == "generate":
        return run_generate()
    if args.command == "train":
        return run_train()
    if args.command == "export":
        return run_export()
    if args.command == "all":
        for step in (run_generate, run_train, run_export):
            code = step()
            if code:
                return code
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
