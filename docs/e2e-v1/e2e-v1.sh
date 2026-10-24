B="http://127.0.0.1:8790"
T="Authorization: Bearer e2e-v1-tok"
OP="x-operator-id: e2e"
J="content-type: application/json"
post() { curl -s -X POST -H "$T" -H "$OP" -H "$J" -d "$2" "$B$1"; }
get()  { curl -s -H "$T" -H "$OP" "$B$1"; }
