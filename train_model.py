"""
ML Timeline Predictor Training Pipeline
Trains an XGBoost model to predict visa decision timelines
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import TimeSeriesSplit, train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, mean_absolute_percentage_error
import json
import os
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# Configuration
DATA_DIR = 'data'
MODEL_DIR = 'models'
os.makedirs(MODEL_DIR, exist_ok=True)

def load_training_data():
    """Load decisions from generated training data"""
    filepath = os.path.join(DATA_DIR, 'training_data.json')
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        return None
    
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    df = pd.DataFrame(data['decisions'])
    print(f"Loaded {len(df)} records from training data")
    return df

def engineer_features(df):
    """Create features for ML model"""
    df = df.copy()
    
    # Convert dates
    df['date'] = pd.to_datetime(df['date'])
    df['application_date'] = pd.to_datetime(df['application_date'])
    
    # Target: days to decision
    df['days_to_decision'] = (df['date'] - df['application_date']).dt.days
    
    # Filter out invalid records
    df = df[(df['days_to_decision'] >= 0) & (df['days_to_decision'] <= 365)]
    
    # Decision encoding (for potential classification)
    df['decision_encoded'] = df['decision'].map({'Granted': 1, 'Refused': 0})
    
    # Extract temporal features from application_date
    df['year'] = df['application_date'].dt.year
    df['month'] = df['application_date'].dt.month
    df['day_of_week'] = df['application_date'].dt.dayofweek  # Monday=0
    df['day_of_month'] = df['application_date'].dt.day
    df['week_of_year'] = df['application_date'].dt.isocalendar().week
    df['quarter'] = df['application_date'].dt.quarter
    df['is_weekend'] = df['day_of_week'].isin([5, 6]).astype(int)
    
    # Embassy encoding
    embassy_dummies = pd.get_dummies(df['embassy'], prefix='embassy')
    df = pd.concat([df, embassy_dummies], axis=1)
    
    # Visa type encoding
    if 'visa_type' in df.columns:
        visa_dummies = pd.get_dummies(df['visa_type'], prefix='visa_type')
        df = pd.concat([df, visa_dummies], axis=1)
    
    # Application number features
    def extract_app_num(number):
        try:
            # Extract numeric part from IRL2026123456
            return int(''.join(filter(str.isdigit, str(number)))[-6:])
        except:
            return 0
    
    df['app_num'] = df['number'].apply(extract_app_num)
    df['app_num_mod_100'] = df['app_num'] % 100
    df['app_num_mod_1000'] = df['app_num'] % 1000
    df['app_num_bucket'] = (df['app_num'] // 100000) * 100000
    
    # Seasonal features
    df['is_peak_season'] = df['month'].isin([5, 6, 7, 8, 12]).astype(int)
    df['is_holiday_period'] = df['month'].isin([12, 1]).astype(int)
    
    # Embassy-level rolling stats (30-day window) - using decision date
    df = df.sort_values(['embassy', 'date'])
    
    # Compute rolling stats per embassy
    for window in [7, 14, 30]:
        df[f'embassy_{window}d_approval_rate'] = df.groupby('embassy')['decision_encoded'].transform(
            lambda x: x.rolling(window, min_periods=1).mean()
        )
        df[f'embassy_{window}d_volume'] = df.groupby('embassy')['decision_encoded'].transform(
            lambda x: x.rolling(window, min_periods=1).count()
        )
    
    # Global rolling stats
    for window in [7, 14, 30]:
        df[f'global_{window}d_approval_rate'] = df['decision_encoded'].rolling(window, min_periods=1).mean()
        df[f'global_{window}d_volume'] = df['decision_encoded'].rolling(window, min_periods=1).count()
    
    # Embassy-specific base processing time (from synthetic data generation)
    base_times = {
        'new-delhi': 45, 'beijing': 35, 'dublin': 20,
        'abu-dhabi': 25, 'abuja': 40, 'ankara': 30
    }
    df['embassy_base_days'] = df['embassy'].map(base_times).fillna(30)
    
    # Visa type base adjustments
    visa_adjustments = {
        'study': 5, 'work': -2, 'visit': -10,
        'family': 5, 'transit': -25, 'research': 3
    }
    df['visa_adjustment'] = df['visa_type'].map(visa_adjustments).fillna(0)
    
    # Drop rows with NaN
    df = df.dropna()
    
    return df

def prepare_features(df):
    """Prepare features and target for training"""
    # Target: days to decision
    y = df['days_to_decision']
    
    # Feature columns (exclude non-numeric and target)
    exclude_cols = [
        'date', 'application_date', 'decision', 'number', 'embassy', 'visa_type',
        'country', 'days_to_decision', 'decision_encoded', 'visa_type_unknown',
        'embassy_unknown'
    ]
    
    # Select numeric features
    feature_cols = [c for c in df.columns if c not in exclude_cols and df[c].dtype in ['int64', 'float64', 'int32', 'float32', 'uint8']]
    
    X = df[feature_cols]
    
    return X, y, feature_cols

def train_model(X_train, y_train, X_val, y_val):
    """Train XGBoost model"""
    params = {
        'objective': 'reg:squarederror',
        'eval_metric': ['mae', 'rmse'],
        'max_depth': 6,
        'learning_rate': 0.1,
        'subsample': 0.8,
        'colsample_bytree': 0.8,
        'n_estimators': 500,
        'early_stopping_rounds': 50,
        'random_state': 42,
        'verbosity': 1,
    }
    
    model = xgb.XGBRegressor(**params)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=50
    )
    return model

def evaluate_model(model, X_test, y_test):
    """Evaluate model performance"""
    preds = model.predict(X_test)
    
    mae = mean_absolute_error(y_test, preds)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    mape = mean_absolute_percentage_error(y_test, preds)
    
    return {
        'mae': float(mae),
        'rmse': float(rmse),
        'mape': float(mape),
        'predictions': preds.tolist()
    }

def export_onnx(model, feature_cols, output_path):
    """Export model to ONNX format"""
    try:
        # Use xgboost's native ONNX export
        import onnx
        from xgboost import XGBRegressor
        
        # Convert to ONNX using xgboost's built-in converter
        model.get_booster().save_model(output_path.replace('.onnx', '.ubj'))
        
        # Try sklearn-onnx for XGBoost (requires newer version)
        try:
            from skl2onnx import convert_sklearn
            from skl2onnx.common.data_types import FloatTensorType
            from skl2onnx import update_registered_converter
            from xgboost import XGBRegressor
            
            # Register XGBoost converter
            from skl2onnx._convert import convert_xgboost
            update_registered_converter(
                XGBRegressor, 'XGBRegressor',
                lambda *args: None,  # shape calculator
                convert_xgboost,
                options={'nocl': [True, False], 'zipmap': [True, False, 'columns']}
            )
            
            initial_type = [('float_input', FloatTensorType([None, len(feature_cols)]))]
            onnx_model = convert_sklearn(model, initial_types=initial_type, target_opset=12)
            
            with open(output_path, 'wb') as f:
                f.write(onnx_model.SerializeToString())
            
            print(f"Model exported to {output_path}")
            return True
        except Exception as e:
            print(f"ONNX export via skl2onnx failed: {e}")
            print("Using native XGBoost format instead")
            return False
            
    except ImportError as e:
        print(f"ONNX export skipped: {e}")
        return False

def save_model_artifacts(model, feature_cols, metrics, output_dir):
    """Save model and metadata"""
    os.makedirs(output_dir, exist_ok=True)
    
    # Save feature columns
    with open(os.path.join(output_dir, 'feature_columns.json'), 'w') as f:
        json.dump(feature_cols, f)
    
    # Save metrics
    with open(os.path.join(output_dir, 'metrics.json'), 'w') as f:
        json.dump(metrics, f, indent=2)
    
    # Save model as pickle (backup)
    import pickle
    with open(os.path.join(output_dir, 'model.pkl'), 'wb') as f:
        pickle.dump(model, f)
    
    # Export ONNX
    model_path = os.path.join(output_dir, 'model.onnx')
    export_onnx(model, feature_cols, model_path)
    
    # Save model info for API
    model_info = {
        'version': '1.0.0',
        'features': feature_cols,
        'target': 'days_to_decision',
        'model_type': 'xgboost',
        'metrics': metrics
    }
    with open(os.path.join(output_dir, 'model_info.json'), 'w') as f:
        json.dump(model_info, f, indent=2)

def main():
    print("Loading training data...")
    df = load_training_data()
    if df is None:
        print("No training data found. Run generate_training_data.py first.")
        return
    
    print("Engineering features...")
    df = engineer_features(df)
    
    print("Preparing features...")
    X, y, feature_cols = prepare_features(df)
    
    print(f"Features: {len(feature_cols)}, Samples: {len(X)}")
    print(f"Feature columns: {feature_cols}")
    print(f"Target stats: mean={y.mean():.1f}, std={y.std():.1f}, min={y.min()}, max={y.max()}")
    
    # Time series split (preserve temporal order)
    tscv = TimeSeriesSplit(n_splits=5)
    
    # Use last split for final evaluation
    splits = list(tscv.split(X))
    train_idx, test_idx = splits[-1]
    
    X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
    y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]
    
    # Further split train for validation
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
    
    # Feature importance
    importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    print("\nTop 20 Features:")
    print(importance.head(20).to_string(index=False))
    
    # Save artifacts
    print("\nSaving model artifacts...")
    save_model_artifacts(model, feature_cols, metrics, MODEL_DIR)
    
    # Save predictions for analysis
    preds = model.predict(X_test)
    results = pd.DataFrame({
        'actual': y_test,
        'predicted': preds,
        'error': np.abs(y_test - preds)
    })
    results.to_csv(os.path.join(MODEL_DIR, 'predictions.csv'), index=False)
    
    print("Training complete!")

if __name__ == '__main__':
    main()