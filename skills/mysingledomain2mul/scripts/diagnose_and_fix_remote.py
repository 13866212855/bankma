import paramiko
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Locally inspect and patch database connection hosts inside a remote docker container.")
    parser.add_argument("--host", default="172.29.173.42", help="Remote SSH server host")
    parser.add_argument("--user", default="gpzx", help="SSH username")
    parser.add_argument("--password", default="9520111", help="SSH password")
    parser.add_argument("--port", type=int, default=22, help="SSH port")
    parser.add_argument("--container", default="zhpj", help="Target Docker container name to diagnose/patch")
    parser.add_argument("--target-host", default="host.docker.internal", help="Database/Redis host replacement target")
    
    args = parser.parse_args()
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"Connecting to remote SSH server {args.user}@{args.host}:{args.port}...")
        ssh.connect(args.host, username=args.user, password=args.password, port=args.port, timeout=10)
        print("✓ Connected successfully.")
        
        # 1. Check if container exists and is running
        print(f"\n--- Checking container: {args.container} ---")
        stdin, stdout, stderr = ssh.exec_command(f"docker ps -a -f name={args.container} --format '{{{{.Names}}}}: {{{{.Status}}}}'")
        container_status = stdout.read().decode('utf-8').strip()
        if not container_status or args.container not in container_status:
            print(f"❌ Error: Container '{args.container}' not found or is not running.")
            return
        print(f"✓ Found: {container_status}")
        
        # 2. Inspect container files
        print(f"\n--- Listing files inside {args.container} ---")
        stdin, stdout, stderr = ssh.exec_command(f"docker exec {args.container} ls -la")
        files_list = stdout.read().decode('utf-8')
        print(files_list)
        
        # 3. Search for connection strings
        print(f"\n--- Scanning container files for connection configs (127.0.0.1 or localhost) ---")
        scan_command = f'docker exec {args.container} grep -rnw "." -e "127.0.0.1" -e "localhost" --exclude-dir={{node_modules,proc,sys,dev}} 2>/dev/null'
        stdin, stdout, stderr = ssh.exec_command(scan_command)
        grep_results = stdout.read().decode('utf-8')
        
        if not grep_results.strip():
            print("No hardcoded localhost/127.0.0.1 connection strings found in standard configuration text files.")
        else:
            print("Found connection candidates:")
            print(grep_results)
            
        # 4. Check Container Env Variables
        print(f"\n--- Checking container Environment variables ---")
        stdin, stdout, stderr = ssh.exec_command(f"docker inspect -f '{{{{range .Config.Env}}}}{{{{.}}}}\\n{{{{end}}}}' {args.container}")
        env_vars = stdout.read().decode('utf-8')
        print(env_vars)
        
        # 5. Automatically patch configs
        patched = False
        
        # Patch .env file if it exists
        if ".env" in files_list:
            print("\nFound a .env file. Checking if we need to patch connection hosts...")
            stdin, stdout, stderr = ssh.exec_command(f"docker exec {args.container} cat .env")
            env_content = stdout.read().decode('utf-8')
            
            if "127.0.0.1" in env_content or "localhost" in env_content:
                print(f"Patching .env to use {args.target_host}...")
                ssh.exec_command(f"docker exec {args.container} sed -i 's/127.0.0.1/{args.target_host}/g' .env")
                ssh.exec_command(f"docker exec {args.container} sed -i 's/localhost/{args.target_host}/g' .env")
                patched = True
                
        # Patch files returned in grep results (only text configurations)
        for line in grep_results.splitlines():
            if ":" in line:
                file_path = line.split(":")[0]
                if file_path.endswith(('.js', '.json', '.env', '.yml', '.yaml')) and "node_modules" not in file_path:
                    print(f"Patching text config file {file_path}...")
                    ssh.exec_command(f"docker exec {args.container} sed -i 's/127.0.0.1/{args.target_host}/g' {file_path}")
                    ssh.exec_command(f"docker exec {args.container} sed -i 's/localhost/{args.target_host}/g' {file_path}")
                    patched = True
                    
        # 6. Restart container to apply patches
        if patched:
            print(f"\n--- Restarting container '{args.container}' to apply patches ---")
            stdin, stdout, stderr = ssh.exec_command(f"docker restart {args.container}")
            print(f"✓ Container {args.container} restarted successfully!")
            
            # Print latest logs
            print(f"\n--- Latest logs from {args.container} ---")
            stdin, stdout, stderr = ssh.exec_command(f"docker logs --tail 20 {args.container}")
            print(stdout.read().decode('utf-8'))
        else:
            print("\nNo automated patches were applied. If the container was created with environment variables in 'docker run', consider recreating it:")
            print(f"docker stop {args.container} && docker rm {args.container}")
            print(f"docker run -d --name {args.container} -p <host-port>:<container-port> --network=mynet -e DB_HOST={args.target_host} <image-name>")
            
    except Exception as e:
        print("Error executing diagnostic and fix:", e)
    finally:
        ssh.close()
        print("\nConnection closed.")

if __name__ == "__main__":
    main()
