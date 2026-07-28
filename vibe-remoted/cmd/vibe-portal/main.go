// vibe-portal：极简静态门户服务。embed web/dist 到二进制，用 http.FileServer 托管，
// 未匹配路径 fallback 到 index.html（SPA 路由）。不参与任何会话数据流——浏览器加载
// 网页后直接连各机器的 vibe-remoted ws://。
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen address")
	flag.Parse()

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}
	fileSvr := http.FileServer(http.FS(sub))

	// SPA fallback：非文件请求路径（如 /some/route）返回 index.html。
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 有扩展名的当静态文件走 FileServer；无扩展名当 SPA route。
		if strings.Contains(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], ".") {
			fileSvr.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		fileSvr.ServeHTTP(w, r)
	})

	log.Printf("vibe-portal listening on %s (serving embedded web/dist)", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}
