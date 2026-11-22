import base64, os, subprocess, glob, sys

D = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'media', 'lang-icons'))
BRAVE = os.path.join(os.environ['LOCALAPPDATA'], 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
SIZE = 68

svgs = sorted(p for p in glob.glob(os.path.join(D, '*.svg')))
for svg in svgs:
    name = os.path.splitext(os.path.basename(svg))[0]
    out = os.path.join(D, name + '.png')
    with open(svg, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    html = os.path.join(D, '_wrap.html')
    with open(html, 'w', encoding='utf-8') as f:
        f.write('<!doctype html><html><body style="margin:0;background:transparent">'
                f'<img src="data:image/svg+xml;base64,{b64}" width="{SIZE}" height="{SIZE}" '
                'style="display:block"></body></html>')
    subprocess.run([BRAVE, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--default-background-color=00000000', f'--window-size={SIZE},{SIZE}',
                    f'--screenshot={out}', 'file:///' + html.replace('\\', '/')],
                   capture_output=True)
    print(name, os.path.getsize(out) if os.path.exists(out) else 'FAIL')
os.remove(os.path.join(D, '_wrap.html'))
