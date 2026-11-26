#!/usr/bin/env ruby
require 'webrick'

port = (ARGV[0] || 8080).to_i
root = File.expand_path(__dir__)

mime_types = WEBrick::HTTPUtils::DefaultMimeTypes.merge(
  'js'   => 'application/javascript; charset=utf-8',
  'mjs'  => 'application/javascript; charset=utf-8',
  'css'  => 'text/css; charset=utf-8',
  'html' => 'text/html; charset=utf-8',
  'pdf'  => 'application/pdf',
  'wasm' => 'application/wasm',
  'svg'  => 'image/svg+xml',
  'json' => 'application/json'
)

server = WEBrick::HTTPServer.new(
  Port: port,
  DocumentRoot: root,
  MimeTypes: mime_types,
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN),
  AccessLog: []
)

trap('INT') { server.shutdown }
trap('TERM') { server.shutdown }

puts "Llibre 3D Studio disponible a http://localhost:#{port}"
server.start
