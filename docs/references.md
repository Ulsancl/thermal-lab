# 원리 참고와 자산

2026-10-02 확인. 아래 자료는 원리와 모형의 한계를 정하는 참고문헌이며 해당 문서·사진·도면·모델 코드를 앱에 복제하지 않습니다.

1. [MIT 2.051 — 열전달 식 요약](https://ocw.mit.edu/courses/2-051-introduction-to-heat-transfer-fall-2015/e32f70f7e00f34953447b606cea0421f_MIT2_051F15_EqnSheet_Q2_v3.pdf): 전도·대류 열저항과 작은 Biot 수에서의 집중용량 모형 조건을 설명합니다. 이 앱은 각 물체를 균일한 평균 온도로 다루는 교육용 근사입니다.
2. [Texas Instruments — Thermal dynamics](https://www.ti.com/video/6243719539001): 열용량과 열 RC망의 시간응답을 설명하는 교육 자료입니다. 앱의 두 온도와 변화 이력은 자체 구현합니다.
3. [Analog Devices — SOAtherm PCB/heat-sink models](https://www.analog.com/en/resources/technical-articles/ltspice-soatherm-support-for-pcb-and-heat-sink-thermal-models.html): 접촉·방열 조건과 과도 열모델을 구분하는 참고입니다. Thermal Lab이 이 도구의 제품 모델·정밀도·안전 검증을 구현한다는 뜻은 아닙니다.

모든 프리셋 열용량·저항·공기 방출 계수는 자체 교육용 설계값이며 위 문헌의 실측 자료나 제조사 사양으로 인용하지 않습니다. 시험대·메시·아이콘은 직접 제작하고, 라이브러리 배포 고지는 [제3자 고지](THIRD-PARTY-NOTICES.md)를 따릅니다.
