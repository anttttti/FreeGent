printf "const a = 1;\nconsole.log(a)\n" > ok.js; node -c ok.js; echo "rc=$?"
printf "foo(\n" > bad.js; node -c bad.js 2>/dev/null; echo "rc=$?"
