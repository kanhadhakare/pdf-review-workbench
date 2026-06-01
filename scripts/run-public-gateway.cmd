@echo off
cd /d E:\pdf-review-workbench
node scripts\public-gateway.mjs 1> public-gateway.log 2> public-gateway.err.log
