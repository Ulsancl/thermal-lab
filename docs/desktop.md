# Windows 앱

Thermal Lab의 대상은 Windows 11 x64입니다. [릴리스](https://github.com/Ulsancl/thermal-lab/releases/latest)에서 설치 파일과 같은 이름의 `.sha256`을 받습니다. 설치를 마친 뒤 바탕화면이나 시작 메뉴의 Thermal Lab 아이콘을 누르면 시작합니다. `npm run package:desktop`은 `release/windows/Thermal-Lab-Setup-1.1.1.exe`와 `.sha256`을 만들며 자동 게시하지 않습니다. 파일 이름의 버전은 package.json을 따르고 실제 설치·하드웨어 결과는 각 릴리스 기록을 따릅니다.

앱 ID는 `com.thermallab.app`, 로컬 화면 주소는 `app://thermal/`입니다. 앱 데이터 폴더의 Thermal Lab 프로필에 자동 저장·창 크기와 위치·실행 로그를 보관합니다. 도움말의 저장 폴더 열기를 사용하세요. 화면 밖으로 나간 창은 현재 작업 영역 안으로 복원합니다.

Ctrl+N/O/S는 새 실험/열기/저장, Ctrl+Shift+P는 재생/일시정지, Ctrl+Shift+F는 3D 크게 보기, F1은 도움말입니다. 파일 작업을 시작하면 일시정지하며 취소하더라도 자동 재생하지 않습니다. 자료 처리나 파일 대화상자 도중 종료하면 확인을 표시합니다. 불러온 파일과 재시작한 실험도 일시정지 상태입니다.

개발·검증용 설치 파일은 서명 없이 만들 수 있습니다. 정식 배포용 설치 파일은 아래의 서명된 빌드 경로를 사용합니다. 자동 업데이트는 없습니다. 실험을 파일로 보관하고 앱을 닫은 뒤 새 설치 파일을 실행합니다. 설치된 앱 실행에는 Node.js나 개발 서버가 필요하지 않습니다. 제거 설정은 사용자 앱 데이터를 자동 삭제하지 않도록 구성했습니다. 제거 프로그램·설정의 정적 확인은 실제 제거 실행 검사와 구분합니다.

## 서명된 Windows 패키지

신뢰할 수 있는 Windows 빌드 환경에서 전자 서명에 사용할 코드 서명 인증서를 electron-builder에 설정하고, 별도 채널로 확인한 해당 인증서 지문을 `THERMAL_WINDOWS_SIGNER_THUMBPRINT`에 지정합니다. `npm run package:release`는 실행 파일과 설치 파일의 Authenticode 유효성 및 게시자 인증서 지문을 검사한 뒤 `release/windows-signed`에 게시용 파일과 SHA-256을 생성합니다. 검증이 실패하면 새 산출물은 게시 위치로 이동하지 않습니다. 서명 자격 증명은 전용 릴리스 환경에서 관리합니다. 구매 또는 배포, 릴리스 게시, 업데이트는 수동입니다.

개발 검사에는 `THERMAL_LAB_DATA_DIR`로 격리 프로필의 실제 로컬 절대 경로를, `THERMAL_DESKTOP_EXE`로 검사할 독립 실행 파일의 절대 경로를 지정합니다. 이 옵션은 소스 앱과 `node scripts/desktop.mjs package-test`로 만든 검사 전용 실행 파일에서 사용할 수 있습니다. 브라우저와 네이티브 화면 검사는 하나씩 실행하세요.
