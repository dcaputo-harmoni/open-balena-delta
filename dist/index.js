"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var bodyParser = require("body-parser");
var express = require("express");
var fs = require("fs");
var child_process_1 = require("child_process");
var crypto = require("crypto");
var PORT = 80;
function createHttpServer(listenPort) {
    return __awaiter(this, void 0, void 0, function () {
        var app;
        return __generator(this, function (_a) {
            app = express();
            app.use(bodyParser.json());
            app.get("/api/v3/delta", function (req, res) {
                var _a;
                var _b, _c;
                var _d = req.query, src = _d.src, dest = _d.dest;
                var auth = (_c = (_b = req.headers["authorization"]) === null || _b === void 0 ? void 0 : _b.split(' ')) === null || _c === void 0 ? void 0 : _c[1];
                if (!src || !dest || !auth) {
                    return res.json({ success: false, message: 'src and dest url params, and auth header, must be provided' });
                }
                var registry = process.env.OPEN_BALENA_REGISTRY;
                if (!registry) {
                    return res.json({ success: false, message: 'registry not configured!' });
                }
                var uuid = crypto.randomUUID();
                var workdir = "/tmp/".concat(uuid);
                var authfile = "".concat(workdir, "/auth.json");
                try {
                    fs.mkdirSync(workdir);
                    fs.writeFileSync("".concat(workdir, "/auth.json"), { auths: (_a = {}, _a[registry] = { auth: auth }, _a) }.toString());
                    fs.copyFileSync("/usr/local/deltaimage", "".concat(workdir, "/deltaimage"));
                    var diff = (0, child_process_1.execSync)("deltaimage docker-file diff ".concat(src, " ").concat(dest)).toString();
                    fs.writeFileSync("".concat(workdir, "/Dockerfie.diff"), diff.replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.'), 'utf8');
                    (0, child_process_1.execSync)("buildah bud --authfile ".concat(authfile, " --no-cache -f ").concat(workdir, "/Dockerfie.diff -t ").concat(uuid, "-diff ").concat(workdir));
                    var delta = (0, child_process_1.execSync)("deltaimage docker-file apply ".concat(uuid, "-diff")).toString();
                    fs.writeFileSync("".concat(workdir, "/Dockerfie.delta"), delta.replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.'), 'utf8');
                    (0, child_process_1.execSync)("buildah bud --authfile ".concat(authfile, " --no-cache -f ").concat(workdir, "/Dockerfie.delta -t ").concat(dest, ":delta-XYZ ").concat(workdir));
                    (0, child_process_1.execSync)("buildah push --authfile ".concat(authfile, " ").concat(dest, ":delta-XYZ"));
                    (0, child_process_1.execSync)("buildah rmi ".concat(uuid, "-diff"));
                    fs.rmdirSync(workdir, { recursive: true });
                    return res.json({ success: true, name: "".concat(dest, ":delta") });
                }
                catch (err) {
                    if (fs.existsSync(workdir))
                        fs.rmdirSync(workdir, { recursive: true });
                    return res.json({ success: false, message: err.message });
                }
            });
            app.listen(listenPort, function () {
                console.log("open-balena-delta is listening on port: ".concat(listenPort));
            });
            return [2];
        });
    });
}
createHttpServer(PORT);
//# sourceMappingURL=index.js.map