import csv
import json
import urllib.request
import urllib.error
import time

WEBHOOK_URL = "http://localhost:5678/webhook/lead-intake"

def main():
    print("Starting bulk ingest...")
    success_count = 0
    error_count = 0

    try:
        with open('data/leads.csv', 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            
            for row in reader:
                # The webhook expects: {"company":"Fly.io","domain":"fly.io","github_org":"superfly"}
                # Adjust these keys if your leads.csv has different column names!
                payload = {
                    "company": row.get("company", ""),
                    "domain": row.get("domain", ""),
                    "github_org": row.get("github_org", "")
                }
                
                print(f"Sending lead: {payload['company']} ({payload['domain']})...", end=" ")
                
                data = json.dumps(payload).encode('utf-8')
                req = urllib.request.Request(
                    WEBHOOK_URL,
                    data=data,
                    headers={'Content-Type': 'application/json'}
                )
                
                try:
                    with urllib.request.urlopen(req) as response:
                        if response.status == 200:
                            print("OK")
                            success_count += 1
                        else:
                            print(f"Failed with status: {response.status}")
                            error_count += 1
                except urllib.error.URLError as e:
                    print(f"Error: {e.reason}")
                    error_count += 1
                
                # Small delay to avoid hammering the webhook/API too hard
                time.sleep(1)
                
    except FileNotFoundError:
        print("Error: data/leads.csv not found!")
        return
        
    print(f"\nIngest complete! Success: {success_count}, Errors: {error_count}")

if __name__ == "__main__":
    main()
