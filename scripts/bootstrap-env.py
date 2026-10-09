from pathlib import Path
import secrets
root=Path(__file__).resolve().parents[1]
p=root/'.env'
if p.exists():
    print('.env already exists; preserved')
else:
    password=secrets.token_hex(24)
    text=(root/'.env.example').read_text().replace('replace-with-random-password',password).replace('replace-with-at-least-48-random-characters',secrets.token_hex(32))
    p.write_text(text);p.chmod(0o600)
    print('Created private development .env')
