#!/usr/bin/env python3
"""
Generate synthetic training data for ML timeline predictor.
Based on the actual embassy volumes and patterns.
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

# Embassy configurations with realistic volumes
EMBASSIES = [
    {"slug": "new-delhi", "name": "New Delhi", "daily_volume": 150, "base_days": 45, "country": "India"},
    {"slug": "beijing", "name": "Beijing", "daily_volume": 50, "base_days": 35, "country": "China"},
    {"slug": "dublin", "name": "Dublin", "daily_volume": 10, "base_days": 20, "country": "Ireland"},
    {"slug": "abu-dhabi", "name": "Abu Dhabi", "daily_volume": 8, "base_days": 25, "country": "UAE"},
    {"slug": "abuja", "name": "Abuja", "daily_volume": 3, "base_days": 40, "country": "Nigeria"},
    {"slug": "ankara", "name": "Ankara", "daily_volume": 0, "base_days": 30, "country": "Turkey"},
]

VISA_TYPES = ["study", "work", "visit", "family", "transit", "research"]
DECISIONS = ["Granted", "Refused"]

# Approval rates by visa type (roughly realistic)
APPROVAL_RATES = {
    "study": 0.85,
    "work": 0.75,
    "visit": 0.70,
    "family": 0.80,
    "transit": 0.90,
    "research": 0.78,
}

# Embassy-specific approval rates
EMBASSY_APPROVAL = {
    "new-delhi": 0.78,
    "beijing": 0.72,
    "dublin": 0.85,
    "abu-dhabi": 0.80,
    "abuja": 0.65,
    "ankara": 0.75,
}

def generate_application_number(base_year=2020):
    """Generate realistic application numbers like IRL123456"""
    year = random.randint(2020, 2026)
    seq = random.randint(100000, 999999)
    return f"IRL{year}{seq}"

def generate_decision_date(application_date_str, visa_type, embassy_slug):
    """Generate a realistic decision date based on visa type and embassy"""
    app_date = datetime.strptime(application_date_str, "%Y-%m-%d")
    
    embassy = next(e for e in EMBASSIES if e["slug"] == embassy_slug)
    base_days = embassy["base_days"]
    
    # Visa type adjustment
    visa_adjustments = {
        "study": 5,
        "work": -2,
        "visit": -10,
        "family": 5,
        "transit": -25,
        "research": 3,
    }
    base_days += visa_adjustments.get(visa_type, 0)
    
    # Seasonal adjustment (peak season: May-Aug, Dec)
    month = app_date.month
    if month in [5, 6, 7, 8, 12]:
        base_days += 7
    if month in [12, 1]:
        base_days += 5
    
    # Weekend adjustment
    if app_date.weekday() >= 5:
        base_days += 2
    
    # Add some randomness
    base_days += random.randint(-5, 10)
    base_days = max(5, min(180, base_days))
    
    decision_date = app_date + timedelta(days=base_days)
    return decision_date.strftime("%Y-%m-%d")

def generate_synthetic_data(num_records=50000):
    """Generate synthetic visa decision data"""
    records = []
    
    # Distribute records according to embassy volumes
    total_volume = sum(e["daily_volume"] for e in EMBASSIES)
    
    for embassy in EMBASSIES:
        if embassy["daily_volume"] == 0:
            continue
            
        # Calculate number of records for this embassy
        embassy_share = embassy["daily_volume"] / total_volume
        embassy_records = int(num_records * embassy_share)
        
        # Generate records over ~3 years
        start_date = datetime(2023, 1, 1)
        end_date = datetime(2026, 1, 1)
        total_days = (end_date - start_date).days
        
        for _ in range(embassy_records):
            # Random application date
            app_day = random.randint(0, total_days)
            app_date = start_date + timedelta(days=app_day)
            app_date_str = app_date.strftime("%Y-%m-%d")
            
            # Skip weekends (embassy closed)
            if app_date.weekday() >= 5:
                continue
            
            # Visa type
            visa_type = random.choices(
                VISA_TYPES, 
                weights=[0.25, 0.20, 0.30, 0.15, 0.05, 0.05]
            )[0]
            
            # Decision based on approval rates
            approval_rate = APPROVAL_RATES[visa_type] * EMBASSY_APPROVAL[embassy["slug"]]
            decision = "Granted" if random.random() < approval_rate else "Refused"
            
            # Decision date
            decision_date_str = generate_decision_date(app_date_str, visa_type, embassy["slug"])
            
            record = {
                "date": decision_date_str,
                "number": generate_application_number(),
                "decision": decision,
                "visa_type": visa_type,
                "embassy": embassy["slug"],
                "application_date": app_date_str,
                "country": embassy["country"]
            }
            records.append(record)
    
    # Sort by decision date
    records.sort(key=lambda x: x["date"], reverse=True)
    return records

def main():
    print("Generating synthetic training data...")
    records = generate_synthetic_data(50000)
    print(f"Generated {len(records)} records")
    
    # Save to data directory
    data_dir = Path("data")
    data_dir.mkdir(exist_ok=True)
    
    output_file = data_dir / "training_data.json"
    with open(output_file, "w") as f:
        json.dump({"decisions": records}, f, indent=2)
    
    print(f"Saved to {output_file}")
    
    # Print statistics
    by_embassy = {}
    by_visa = {}
    by_decision = {}
    
    for r in records:
        by_embassy[r["embassy"]] = by_embassy.get(r["embassy"], 0) + 1
        by_visa[r["visa_type"]] = by_visa.get(r["visa_type"], 0) + 1
        by_decision[r["decision"]] = by_decision.get(r["decision"], 0) + 1
    
    print("\nBy Embassy:")
    for k, v in sorted(by_embassy.items()):
        print(f"  {k}: {v}")
    
    print("\nBy Visa Type:")
    for k, v in sorted(by_visa.items()):
        print(f"  {k}: {v}")
    
    print("\nBy Decision:")
    for k, v in sorted(by_decision.items()):
        print(f"  {k}: {v}")

if __name__ == "__main__":
    main()