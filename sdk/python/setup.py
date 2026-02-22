from setuptools import setup, find_packages

setup(
    name="anybrowse",
    version="0.1.0",
    description="Python SDK for the Anybrowse web scraping and search API with x402 micropayments",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="Anybrowse",
    url="https://anybrowse.dev",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[
        "requests>=2.25.0",
    ],
    extras_require={
        "payment": [
            "eth-account>=0.9.0",
        ],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
)
